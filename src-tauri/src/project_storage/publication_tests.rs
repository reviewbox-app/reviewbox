use super::*;
use std::{fs, path::PathBuf, sync::Arc};

fn repository() -> (tempfile::TempDir, Project) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    git(root, &["init", "-b", "main"]).unwrap();
    git(root, &["config", "user.name", "ReviewBox test"]).unwrap();
    git(root, &["config", "user.email", "reviewbox@example.invalid"]).unwrap();
    git(root, &["config", "commit.gpgsign", "false"]).unwrap();
    fs::write(root.join("source.txt"), "base\n").unwrap();
    git(root, &["add", "source.txt"]).unwrap();
    commit(root, "base");
    let project = Project {
        root: root.join(".reviewbox"),
        repository_id: "repository".into(),
        project_id: "project".into(),
        cache: Arc::default(),
        origins: Arc::default(),
        sources: Arc::default(),
    };
    (directory, project)
}

fn commit(root: &Path, message: &str) -> String {
    git(root, &["commit", "-m", message]).unwrap();
    text(root, &["rev-parse", "HEAD"]).unwrap()
}

fn fixture(review_id: &str) -> Files {
    let mut files = BTreeMap::from([
        (
            "reviews/review.json".into(),
            b"{\"review\":\"complete\"}\n".to_vec(),
        ),
        (
            "snapshots/snapshot.json".into(),
            b"{\"snapshot\":\"captured\"}\n".to_vec(),
        ),
        (
            "content/snapshot/0001.json".into(),
            b"\0\xffbinary\r\nwithout final newline".to_vec(),
        ),
    ]);
    seal_bundle(review_id, &mut files).unwrap();
    files
}

fn write_bundle(root: &Path, review_id: &str, files: &Files) -> PathBuf {
    let directory = root.join(publication_path(review_id).unwrap());
    for (path, content) in files {
        let target = directory.join(path);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(target, content).unwrap();
    }
    directory
}

fn publish(root: &Path, review_id: &str, files: &Files) -> String {
    write_bundle(root, review_id, files);
    git(root, &["add", "--", &publication_path(review_id).unwrap()]).unwrap();
    commit(root, "publish review")
}

fn ready(decision: ArchiveDecision) -> ArchiveLocation {
    match decision {
        ArchiveDecision::Ready(location) => location,
        ArchiveDecision::Deferred(reason) => panic!("Unexpected deferred archive: {reason}"),
    }
}

#[test]
fn inventory_is_exact_deterministic_and_rejects_private_paths() {
    let files = fixture("review-01");
    let first = bundle_hash(&files).unwrap();
    let mut repeated = files.clone();
    seal_bundle("review-01", &mut repeated).unwrap();
    assert_eq!(files, repeated);
    assert_eq!(bundle_hash(&repeated).unwrap(), first);
    let mut extra = files.clone();
    extra.insert("extra.txt".into(), b"surprise".to_vec());
    assert!(verify_bundle(&extra).is_err());
    let mut missing = files.clone();
    missing.remove("snapshots/snapshot.json");
    assert!(verify_bundle(&missing).is_err());
    let mut corrupted = files.clone();
    corrupted.get_mut("content/snapshot/0001.json").unwrap()[0] = 4;
    assert!(verify_bundle(&corrupted).is_err());
    for path in [
        ".local/cache",
        "../outside",
        "./alias",
        "content//part",
        "content\\part",
        "/absolute",
    ] {
        let mut invalid = Files::from([(path.into(), b"content".to_vec())]);
        assert!(seal_bundle("review-01", &mut invalid).is_err(), "{path}");
    }
}

#[test]
fn eight_later_commits_still_reference_first_complete_appearance_without_index_writes() {
    let (dir, project) = repository();
    let root = dir.path();
    let files = fixture("review-01");
    let first = publish(root, "review-01", &files);
    for i in 0..8 {
        fs::write(root.join("source.txt"), format!("iteration {i}\n")).unwrap();
        git(root, &["add", "source.txt"]).unwrap();
        commit(root, &format!("iteration {i}"));
    }
    fs::write(root.join("source.txt"), "unrelated staged edit\n").unwrap();
    git(root, &["add", "source.txt"]).unwrap();
    let index_before = fs::read(root.join(".git/index")).unwrap();
    let location = ready(archive_candidate(&project, "review-01", &files, |_, _| Ok(())).unwrap());
    assert_eq!(location.commit, first);
    assert_eq!(
        read_archive(&project, "review-01", &location, |_, _| Ok(())).unwrap(),
        files
    );
    assert_eq!(fs::read(root.join(".git/index")).unwrap(), index_before);
}

#[test]
fn partial_and_uncommitted_publications_wait_until_all_files_are_committed() {
    let (dir, project) = repository();
    let root = dir.path();
    let files = fixture("review-01");
    write_bundle(root, "review-01", &files);
    assert!(matches!(
        archive_candidate(&project, "review-01", &files, |_, _| Ok(())).unwrap(),
        ArchiveDecision::Deferred(_)
    ));
    git(
        root,
        &["add", ".reviewbox/published/review-01/reviews/review.json"],
    )
    .unwrap();
    commit(root, "only review metadata");
    assert!(matches!(
        archive_candidate(&project, "review-01", &files, |_, _| Ok(())).unwrap(),
        ArchiveDecision::Deferred(_)
    ));
    git(root, &["add", ".reviewbox/published/review-01"]).unwrap();
    assert!(matches!(
        archive_candidate(&project, "review-01", &files, |_, _| Ok(())).unwrap(),
        ArchiveDecision::Deferred(_)
    ));
    let complete = commit(root, "complete publication");
    assert_eq!(
        ready(archive_candidate(&project, "review-01", &files, |_, _| Ok(())).unwrap()).commit,
        complete
    );
}

#[test]
fn staged_worktree_and_missing_source_mutations_defer_rotation() {
    let (dir, project) = repository();
    let root = dir.path();
    let files = fixture("review-01");
    publish(root, "review-01", &files);
    let mut changed = files.clone();
    changed.insert("reviews/review.json".into(), b"modified".to_vec());
    seal_bundle("review-01", &mut changed).unwrap();
    write_bundle(root, "review-01", &changed);
    assert!(matches!(
        archive_candidate(&project, "review-01", &changed, |_, _| Ok(())).unwrap(),
        ArchiveDecision::Deferred(_)
    ));
    git(root, &["add", ".reviewbox/published/review-01"]).unwrap();
    assert!(matches!(
        archive_candidate(&project, "review-01", &changed, |_, _| Ok(())).unwrap(),
        ArchiveDecision::Deferred(_)
    ));
    git(
        root,
        &["reset", "HEAD", "--", ".reviewbox/published/review-01"],
    )
    .unwrap();
    write_bundle(root, "review-01", &files);
    let deferred = archive_candidate(&project, "review-01", &files, |_, _| {
        Err(AppError::new(
            "missing_git_object",
            "A required Git source is missing.",
        ))
    })
    .unwrap();
    assert!(
        matches!(deferred, ArchiveDecision::Deferred(message) if message.contains("required Git source"))
    );
}

#[test]
fn independent_first_appearances_use_oid_order_not_dates_or_first_parent() {
    let (dir, project) = repository();
    let root = dir.path();
    let base = text(root, &["rev-parse", "HEAD"]).unwrap();
    let files = fixture("review-01");
    let first = publish(root, "review-01", &files);
    git(root, &["checkout", "-b", "parallel", &base]).unwrap();
    write_bundle(root, "review-01", &files);
    git(root, &["add", ".reviewbox/published/review-01"]).unwrap();
    let parallel = commit(root, "independent publication");
    git(root, &["checkout", "main"]).unwrap();
    git(
        root,
        &[
            "merge",
            "--no-ff",
            "parallel",
            "-m",
            "merge both publications",
        ],
    )
    .unwrap();
    let result = ready(archive_candidate(&project, "review-01", &files, |_, _| Ok(())).unwrap());
    assert_eq!(result.commit, std::cmp::min(first, parallel));
}

#[test]
fn unavailable_base_may_first_become_reconstructible_in_a_later_commit() {
    let (dir, project) = repository();
    let root = dir.path();
    let files = fixture("review-01");
    publish(root, "review-01", &files);
    fs::write(root.join("source.txt"), "now dependency is reachable\n").unwrap();
    git(root, &["add", "source.txt"]).unwrap();
    let later = commit(root, "dependency arrives without changing publication");
    let result = ready(
        archive_candidate(&project, "review-01", &files, |_, commit| {
            if commit == later {
                Ok(())
            } else {
                Err(archive_error("Missing source ancestor."))
            }
        })
        .unwrap(),
    );
    assert_eq!(result.commit, later);
}

#[test]
fn missing_git_history_defers_rotation_without_blocking_another_publication() {
    let (dir, project) = repository();
    let root = dir.path();
    let files = fixture("review-01");
    let commit = publish(root, "review-01", &files);
    let object = root
        .join(".git/objects")
        .join(&commit[..2])
        .join(&commit[2..]);
    fs::remove_file(object).unwrap();
    assert!(matches!(
        archive_candidate(&project, "review-01", &files, |_, _| Ok(())).unwrap(),
        ArchiveDecision::Deferred(_)
    ));
}

#[test]
fn concurrent_history_changes_defer_archive_removal() {
    let (dir, project) = repository();
    let root = dir.path();
    let files = fixture("review-01");
    publish(root, "review-01", &files);
    let result = archive_candidate(&project, "review-01", &files, |_, _| {
        git(
            root,
            &["commit", "--allow-empty", "-m", "concurrent Git operation"],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
    assert!(
        matches!(result, ArchiveDecision::Deferred(reason) if reason.contains("history changed"))
    );
}

#[test]
fn archives_read_in_another_clone_without_working_copy_or_cache() {
    let (dir, project) = repository();
    let root = dir.path();
    let files = fixture("review-01");
    publish(root, "review-01", &files);
    let location = ready(archive_candidate(&project, "review-01", &files, |_, _| Ok(())).unwrap());
    let clone_parent = tempfile::tempdir().unwrap();
    let clone_root = clone_parent.path().join("clone");
    git(
        clone_parent.path(),
        &["clone", "--no-hardlinks", root.to_str().unwrap(), "clone"],
    )
    .unwrap();
    fs::remove_dir_all(clone_root.join(".reviewbox")).unwrap();
    fs::write(clone_root.join("source.txt"), "unrelated live code").unwrap();
    let clone_project = Project {
        root: clone_root.join(".reviewbox"),
        ..project.clone()
    };
    assert_eq!(
        read_archive(&clone_project, "review-01", &location, |_, _| Ok(())).unwrap(),
        files
    );
    let mut wrong = location.clone();
    wrong.bundle_hash = "0".repeat(64);
    assert!(read_archive(&clone_project, "review-01", &wrong, |_, _| Ok(())).is_err());
    wrong = location.clone();
    wrong.path = "../source.txt".into();
    assert!(read_archive(&clone_project, "review-01", &wrong, |_, _| Ok(())).is_err());
    wrong = location;
    wrong.commit = "0".repeat(40);
    assert_eq!(
        read_archive(&clone_project, "review-01", &wrong, |_, _| Ok(()))
            .unwrap_err()
            .code,
        "missing_archive"
    );
}

#[test]
fn shallow_history_defers_discovery_but_reads_known_available_archive() {
    let (dir, project) = repository();
    let root = dir.path();
    let files = fixture("review-01");
    publish(root, "review-01", &files);
    let location = ready(archive_candidate(&project, "review-01", &files, |_, _| Ok(())).unwrap());
    let clone_parent = tempfile::tempdir().unwrap();
    git(
        clone_parent.path(),
        &[
            "clone",
            "--depth",
            "1",
            &format!("file://{}", root.display()),
            "clone",
        ],
    )
    .unwrap();
    let clone_project = Project {
        root: clone_parent.path().join("clone/.reviewbox"),
        ..project
    };
    assert!(
        matches!(archive_candidate(&clone_project, "review-01", &files, |_, _| Ok(())).unwrap(), ArchiveDecision::Deferred(reason) if reason.contains("shallow"))
    );
    assert_eq!(
        read_archive(&clone_project, "review-01", &location, |_, _| Ok(())).unwrap(),
        files
    );
}

#[cfg(unix)]
#[test]
fn archive_symlinks_are_not_followed() {
    let (dir, project) = repository();
    let root = dir.path();
    let files = fixture("review-01");
    let location = ArchiveLocation {
        commit: publish(root, "review-01", &files),
        path: publication_path("review-01").unwrap(),
        bundle_hash: bundle_hash(&files).unwrap(),
    };
    let path = root.join(&location.path).join("reviews/review.json");
    fs::remove_file(&path).unwrap();
    std::os::unix::fs::symlink(root.join("source.txt"), path).unwrap();
    git(root, &["add", ".reviewbox/published/review-01"]).unwrap();
    let bad_commit = commit(root, "replace a bundle file with a symlink");
    let wrong = ArchiveLocation {
        commit: bad_commit,
        ..location
    };
    assert!(read_archive(&project, "review-01", &wrong, |_, _| Ok(())).is_err());
}

fn blob(text: &str) -> BlobRef {
    BlobRef {
        hash: fingerprint(text.as_bytes()),
        size: text.len() as u32,
        mode: "100644".into(),
    }
}

fn snapshot(scope: crate::contracts::Scope, before: &str, after: &str) -> Snapshot {
    Snapshot {
        id: "snapshot".into(),
        repository_id: "repository".into(),
        created_at: "today".into(),
        request: crate::contracts::CaptureRequest {
            repository_id: "repository".into(),
            scope,
            base: None,
            target: None,
            include_untracked: true,
        },
        head: "unneeded-for-content-matching".into(),
        workspace_fingerprint: String::new(),
        head_fingerprint: String::new(),
        index_fingerprint: String::new(),
        git_refs: Vec::new(),
        files: vec![crate::contracts::SnapshotFile {
            path: "source.txt".into(),
            content: blob(after),
        }],
        changes: vec![crate::contracts::Change {
            id: "change".into(),
            path: "source.txt".into(),
            previous_path: None,
            layer: "unstaged".into(),
            before: Some(blob(before)),
            after: Some(blob(after)),
            binary: false,
            passages: Vec::new(),
            untracked: false,
        }],
    }
}

#[test]
fn commit_matching_excludes_metadata_and_rejects_unreviewed_staged_changes() {
    let (dir, project) = repository();
    let root = dir.path();
    let local = snapshot(crate::contracts::Scope::Local, "base\n", "new\n");
    let unstaged = snapshot(
        crate::contracts::Scope::Unstaged,
        "staged intermediate\n",
        "new\n",
    );
    fs::write(root.join("source.txt"), "new\n").unwrap();
    write_bundle(root, "review-01", &fixture("review-01"));
    git(root, &["add", "."]).unwrap();
    let matching = commit(root, "code and review together");
    assert_eq!(
        matching_commits(&project, &local).unwrap(),
        vec![matching.clone()]
    );
    assert!(matching_commits(&project, &unstaged).unwrap().is_empty());
    fs::write(root.join(".reviewbox/settings.json"), "metadata only\n").unwrap();
    git(root, &["add", ".reviewbox/settings.json"]).unwrap();
    commit(root, "metadata changes do not mean another reviewed commit");
    assert_eq!(matching_commits(&project, &local).unwrap(), vec![matching]);
}

#[test]
fn multi_commit_range_does_not_validate_its_individual_commits() {
    let (dir, project) = repository();
    let root = dir.path();
    fs::write(root.join("source.txt"), "intermediate\n").unwrap();
    git(root, &["add", "source.txt"]).unwrap();
    commit(root, "intermediate change");
    fs::write(root.join("source.txt"), "final\n").unwrap();
    git(root, &["add", "source.txt"]).unwrap();
    let final_commit = commit(root, "final change");
    let range = snapshot(crate::contracts::Scope::Range, "base\n", "final\n");
    assert!(matching_commits(&project, &range).unwrap().is_empty());
    let last = snapshot(crate::contracts::Scope::Commit, "intermediate\n", "final\n");
    assert_eq!(
        matching_commits(&project, &last).unwrap(),
        vec![final_commit]
    );
}

#[test]
fn scope_hash_ignores_capture_ids_and_metadata_but_preserves_intermediate_layers() {
    let original = snapshot(crate::contracts::Scope::Local, "base\n", "new\n");
    let original_hash = scope_fingerprint(&original).unwrap();
    let mut copy = original.clone();
    copy.id = "different capture UUID".into();
    copy.created_at = "next week".into();
    copy.changes[0].id = "different change UUID".into();
    copy.files.push(crate::contracts::SnapshotFile {
        path: ".reviewbox/arbitrary.json".into(),
        content: blob("ignored"),
    });
    let mut metadata = copy.changes[0].clone();
    metadata.path = ".reviewbox/arbitrary.json".into();
    copy.changes.push(metadata);
    assert_eq!(scope_fingerprint(&copy).unwrap(), original_hash);
    let mut layered = original;
    let mut staged = layered.changes[0].clone();
    staged.layer = "staged".into();
    staged.after = Some(blob("intermediate\n"));
    layered.changes[0].before = Some(blob("intermediate\n"));
    layered.changes.insert(0, staged);
    assert_ne!(scope_fingerprint(&layered).unwrap(), original_hash);
    let (before, after) = captured_trees(&layered).unwrap();
    assert!(same_blob(before.get("source.txt"), Some(&blob("base\n"))));
    assert!(same_blob(after.get("source.txt"), Some(&blob("new\n"))));
}
