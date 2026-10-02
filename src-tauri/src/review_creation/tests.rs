use super::*;
use crate::{contracts::Scope, repositories};
use std::{fs, path::Path, process::Command};

fn git(root: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
fn fixture() -> (tempfile::TempDir, Storage, Repository, CaptureRequest) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("repo");
    fs::create_dir(&root).unwrap();
    git(&root, &["init", "-q"]);
    git(
        &root,
        &["config", "user.email", "reviewbox@example.invalid"],
    );
    git(&root, &["config", "user.name", "ReviewBox test"]);
    fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
    git(&root, &["add", "."]);
    git(
        &root,
        &["-c", "commit.gpgsign=false", "commit", "-qm", "initial"],
    );
    let storage = Storage::open(dir.path().join("data")).unwrap();
    let repo = repositories::open(&storage, root.to_str().unwrap()).unwrap();
    let request = CaptureRequest {
        repository_id: repo.id.clone(),
        scope: Scope::Local,
        base: None,
        target: None,
        include_untracked: false,
    };
    (dir, storage, repo, request)
}
fn scope(preview: &ReviewPreview, scope: Scope) -> &ScopePreview {
    preview
        .scopes
        .iter()
        .find(|item| item.scope == scope)
        .unwrap()
}

#[test]
fn new_project_defaults_capture_untracked_and_honor_gitignore() {
    let (_dir, storage, repo, mut request) = fixture();
    let root = Path::new(&repo.path);
    fs::write(root.join(".gitignore"), "ignored.txt\n").unwrap();
    git(root, &["add", ".gitignore"]);
    git(
        root,
        &[
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-qm",
            "Ignore generated file",
        ],
    );
    fs::write(root.join("new.txt"), "new source\n").unwrap();
    fs::write(root.join("ignored.txt"), "ignored content\n").unwrap();
    let index = fs::read(root.join(".git/index")).unwrap();
    let mut settings = storage.project_settings(&repo.id).unwrap();
    request.include_untracked = settings.include_untracked;
    for current_scope in [Scope::Local, Scope::Unstaged] {
        request.scope = current_scope.clone();
        let stats = preview(&storage, &request).unwrap();
        assert_eq!(scope(&stats, current_scope).files, 1);
        assert_eq!(stats.untracked_files, 1);
        let manager = CaptureManager::default();
        let task = manager.begin("default-inclusion").unwrap();
        let workspace = create(&storage, request.clone(), task, |_| Ok(())).unwrap();
        manager.finish("default-inclusion");
        assert_eq!(workspace.snapshot.changes.len(), 1);
        assert_eq!(workspace.snapshot.changes[0].path, "new.txt");
    }
    // An explicit project preference keeps its existing serialized meaning.
    settings.include_untracked = false;
    storage.save_project_settings(&repo.id, settings).unwrap();
    request.include_untracked = storage
        .project_settings(&repo.id)
        .unwrap()
        .include_untracked;
    let stats = preview(&storage, &request).unwrap();
    assert_eq!(scope(&stats, Scope::Local).files, 0);
    assert_eq!(scope(&stats, Scope::Unstaged).files, 0);
    assert_eq!(fs::read(root.join(".git/index")).unwrap(), index);
}

#[test]
fn preview_counts_layers_unique_paths_binaries_and_never_publishes() {
    let (_dir, storage, repo, mut request) = fixture();
    let root = Path::new(&repo.path);
    fs::write(root.join("a.txt"), "staged\ntwo\n").unwrap();
    git(root, &["add", "a.txt"]);
    fs::write(root.join("a.txt"), "working\ntwo\n").unwrap();
    fs::write(root.join("new.txt"), "three\nfour").unwrap();
    fs::write(root.join("image.bin"), [0, 1, 2]).unwrap();
    let before = fs::read(root.join(".git/index")).unwrap();
    let blobs = fs::read_dir(storage.root().join("blobs")).unwrap().count();
    let without = preview(&storage, &request).unwrap();
    let local = scope(&without, Scope::Local);
    assert_eq!(
        (
            local.files,
            local.additions,
            local.deletions,
            local.partially_staged_files
        ),
        (1, 2, 2, 1)
    );
    assert_eq!(without.untracked_files, 2);
    request.include_untracked = true;
    let with = preview(&storage, &request).unwrap();
    let local = scope(&with, Scope::Local);
    assert_eq!(
        (
            local.files,
            local.additions,
            local.deletions,
            local.binary_files
        ),
        (3, 4, 2, 1)
    );
    assert_eq!(fs::read(root.join(".git/index")).unwrap(), before);
    assert_eq!(
        fs::read_dir(storage.root().join("blobs")).unwrap().count(),
        blobs
    );
    assert!(storage.list::<Snapshot>("snapshot").unwrap().is_empty());
    assert!(storage.list::<Review>("review").unwrap().is_empty());
}

#[test]
fn preview_ignores_project_metadata_and_handles_root_commit_refs() {
    let (_dir, storage, repo, request) = fixture();
    let root = Path::new(&repo.path);
    fs::write(root.join(".reviewbox/not-a-document.json"), "metadata only").unwrap();
    git(root, &["add", ".reviewbox"]);
    let stats = preview(&storage, &request).unwrap();
    assert_eq!(scope(&stats, Scope::Local).files, 0);
    assert_eq!(scope(&stats, Scope::Commit).files, 1);
    assert_eq!(scope(&stats, Scope::Commit).commit_count, Some(1));
    assert_eq!(scope(&stats, Scope::Range).files, 0);
    git(root, &["tag", "v1"]);
    let matches = references(&storage, &repo.id, "v1").unwrap();
    assert!(
        matches
            .iter()
            .any(|item| item.kind == "tag" && item.name == "v1")
    );
    let head = repositories::resolve(root, "HEAD").unwrap();
    assert!(
        references(&storage, &repo.id, &head)
            .unwrap()
            .iter()
            .any(|item| item.oid == head)
    );
    let invalid = CaptureRequest {
        target: Some("not-a-reference".into()),
        ..request
    };
    assert!(
        scope(&preview(&storage, &invalid).unwrap(), Scope::Commit)
            .error
            .is_some()
    );
}

#[test]
fn cancellation_before_publication_leaves_no_snapshot_or_review() {
    let (_dir, storage, repo, request) = fixture();
    fs::write(Path::new(&repo.path).join("a.txt"), "changed\n").unwrap();
    let manager = CaptureManager::default();
    let task = manager.begin("cancel-test").unwrap();
    let result = create(&storage, request, task, |progress| {
        if progress.phase == "publishing" {
            manager.cancel("cancel-test")?;
        }
        Ok(())
    });
    manager.finish("cancel-test");
    assert_eq!(result.unwrap_err().code, "cancelled");
    assert!(storage.list::<Snapshot>("snapshot").unwrap().is_empty());
    assert!(storage.list::<Review>("review").unwrap().is_empty());
}

#[test]
fn source_change_during_capture_is_rejected_and_success_is_atomic() {
    let (_dir, storage, repo, request) = fixture();
    let file = Path::new(&repo.path).join("a.txt");
    fs::write(&file, "before\n").unwrap();
    let manager = CaptureManager::default();
    let task = manager.begin("changed").unwrap();
    let mut changed = false;
    let result = create(&storage, request.clone(), task, |progress| {
        if progress.phase == "verifying" && !changed {
            fs::write(&file, "after\n").unwrap();
            changed = true;
        }
        Ok(())
    });
    manager.finish("changed");
    assert_eq!(result.unwrap_err().code, "capture_changed");
    assert!(storage.list::<Snapshot>("snapshot").unwrap().is_empty());
    let task = manager.begin("success").unwrap();
    let mut phases = Vec::new();
    let workspace = create(&storage, request, task, |p| {
        phases.push(p.phase);
        Ok(())
    })
    .unwrap();
    assert_eq!(
        manager.cancel("success").unwrap_err().code,
        "capture_completed"
    );
    manager.finish("success");
    assert_eq!(storage.list::<Snapshot>("snapshot").unwrap().len(), 1);
    assert_eq!(storage.list::<Review>("review").unwrap().len(), 1);
    assert_eq!(workspace.review.snapshot_id, workspace.snapshot.id);
    assert_eq!(phases.last().unwrap(), "completed");
    assert!(workspace.review.topics.is_empty());
    assert!(workspace.review.decisions.is_empty());
}

#[test]
fn empty_new_capture_fails_without_publication() {
    let (_dir, storage, _repo, request) = fixture();
    let manager = CaptureManager::default();
    let task = manager.begin("empty").unwrap();
    let result = create(&storage, request, task, |_| Ok(()));
    manager.finish("empty");
    assert_eq!(result.unwrap_err().code, "empty_scope");
    assert!(storage.list::<Snapshot>("snapshot").unwrap().is_empty());
    assert!(storage.list::<Review>("review").unwrap().is_empty());
}

#[test]
fn all_scopes_use_the_same_line_and_binary_rules_as_capture() {
    let (_dir, storage, repo, request) = fixture();
    let root = Path::new(&repo.path);
    fs::write(root.join("a.txt"), "staged\ntwo\n").unwrap();
    fs::write(root.join("non-utf8.txt"), [255, 254, 10]).unwrap();
    git(root, &["add", "a.txt", "non-utf8.txt"]);
    fs::write(root.join("a.txt"), "working\ntwo\nthree\n").unwrap();
    fs::write(root.join("new.txt"), "new\n").unwrap();
    for current_scope in [Scope::Local, Scope::Unstaged, Scope::Staged] {
        let request = CaptureRequest {
            scope: current_scope.clone(),
            include_untracked: true,
            ..request.clone()
        };
        let stats = preview(&storage, &request).unwrap();
        let current = scope(&stats, current_scope);
        let captured = snapshots::capture(&storage, request).unwrap();
        let paths: std::collections::BTreeSet<_> =
            captured.changes.iter().map(|c| &c.path).collect();
        let binaries: std::collections::BTreeSet<_> = captured
            .changes
            .iter()
            .filter(|c| c.binary)
            .map(|c| &c.path)
            .collect();
        let additions: u32 = captured
            .changes
            .iter()
            .flat_map(|c| &c.passages)
            .map(|p| p.new_lines)
            .sum();
        let deletions: u32 = captured
            .changes
            .iter()
            .flat_map(|c| &c.passages)
            .map(|p| p.old_lines)
            .sum();
        assert_eq!(
            (
                current.files,
                current.additions,
                current.deletions,
                current.binary_files
            ),
            (
                paths.len() as u32,
                additions,
                deletions,
                binaries.len() as u32
            )
        );
    }
    git(
        root,
        &["-c", "commit.gpgsign=false", "commit", "-qm", "second"],
    );
    let range = CaptureRequest {
        scope: Scope::Range,
        base: Some("HEAD~1".into()),
        target: Some("HEAD".into()),
        ..request
    };
    let stats = preview(&storage, &range).unwrap();
    assert_eq!(scope(&stats, Scope::Range).commit_count, Some(1));
    assert_eq!(scope(&stats, Scope::Range).files, 2);
    assert_eq!(scope(&stats, Scope::Range).binary_files, 1);
}

#[test]
fn unborn_repository_and_recreated_staged_deletion_are_counted() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("repo");
    fs::create_dir(&root).unwrap();
    git(&root, &["init", "-q"]);
    let storage = Storage::open(dir.path().join("data")).unwrap();
    let repo = repositories::open(&storage, root.to_str().unwrap()).unwrap();
    fs::write(root.join("initial.txt"), "first\n").unwrap();
    git(&root, &["add", "initial.txt"]);
    let request = CaptureRequest {
        repository_id: repo.id,
        scope: Scope::Local,
        base: None,
        target: None,
        include_untracked: false,
    };
    let stats = preview(&storage, &request).unwrap();
    assert_eq!(scope(&stats, Scope::Staged).files, 1);
    assert_eq!(scope(&stats, Scope::Staged).additions, 1);
    assert!(scope(&stats, Scope::Commit).error.is_some());

    let (_dir, storage, repo, request) = fixture();
    let root = Path::new(&repo.path);
    git(root, &["rm", "a.txt"]);
    fs::write(root.join("a.txt"), "recreated\n").unwrap();
    let request = CaptureRequest {
        include_untracked: true,
        ..request
    };
    let stats = preview(&storage, &request).unwrap();
    let local = scope(&stats, Scope::Local);
    assert_eq!(
        (
            local.files,
            local.partially_staged_files,
            local.additions,
            local.deletions
        ),
        (1, 1, 1, 2)
    );
}

#[test]
fn publication_failure_does_not_leave_a_review_without_its_snapshot() {
    let (_dir, storage, repo, request) = fixture();
    fs::write(Path::new(&repo.path).join("a.txt"), "changed\n").unwrap();
    let snapshot = snapshots::capture(&storage, request).unwrap();
    let result = reviews::publish_creation(&storage, snapshot);
    assert!(
        result.is_err(),
        "The existing snapshot must make the batch fail."
    );
    assert!(storage.list::<Review>("review").unwrap().is_empty());
    assert_eq!(storage.list::<Snapshot>("snapshot").unwrap().len(), 1);
}

#[test]
fn shallow_missing_parent_is_not_silently_treated_as_a_root_commit() {
    let (dir, _storage, repo, _request) = fixture();
    let root = Path::new(&repo.path);
    fs::write(root.join("a.txt"), "second\n").unwrap();
    git(root, &["add", "a.txt"]);
    git(
        root,
        &["-c", "commit.gpgsign=false", "commit", "-qm", "second"],
    );
    let clone = dir.path().join("shallow");
    git(
        dir.path(),
        &[
            "clone",
            "--quiet",
            "--depth=1",
            &format!("file://{}", repo.path),
            clone.to_str().unwrap(),
        ],
    );
    let storage = Storage::open(dir.path().join("shallow-data")).unwrap();
    let repository = repositories::open(&storage, clone.to_str().unwrap()).unwrap();
    let request = CaptureRequest {
        repository_id: repository.id,
        scope: Scope::Commit,
        base: None,
        target: None,
        include_untracked: false,
    };
    let stats = preview(&storage, &request).unwrap();
    assert!(
        scope(&stats, Scope::Commit)
            .error
            .as_ref()
            .unwrap()
            .contains("parent is unavailable")
    );
    let manager = CaptureManager::default();
    let task = manager.begin("shallow").unwrap();
    assert_eq!(
        create(&storage, request, task, |_| Ok(()))
            .unwrap_err()
            .code,
        "missing_commit"
    );
    manager.finish("shallow");
    assert!(storage.list::<Snapshot>("snapshot").unwrap().is_empty());
    assert!(storage.list::<Review>("review").unwrap().is_empty());
}

#[test]
fn closed_progress_channel_before_publication_keeps_only_disposable_cache() {
    let (dir, storage, repo, request) = fixture();
    fs::write(Path::new(&repo.path).join("a.txt"), "changed\n").unwrap();
    let manager = CaptureManager::default();
    let task = manager.begin("lost-before-publish").unwrap();
    let result = create(&storage, request, task, |progress| {
        if progress.phase == "publishing" {
            return Err(AppError::new("cancelled", "The capture window was closed."));
        }
        Ok(())
    });
    manager.finish("lost-before-publish");
    assert_eq!(result.unwrap_err().code, "cancelled");
    assert!(fs::read_dir(storage.root().join("blobs")).unwrap().count() > 0);
    drop(storage);
    let reopened = Storage::open(dir.path().join("data")).unwrap();
    repositories::open(&reopened, &repo.path).unwrap();
    assert!(reopened.list::<Snapshot>("snapshot").unwrap().is_empty());
    assert!(reopened.list::<Review>("review").unwrap().is_empty());
}

#[test]
fn closed_completion_channel_never_turns_a_saved_review_into_retryable_failure() {
    let (dir, storage, repo, request) = fixture();
    fs::write(Path::new(&repo.path).join("a.txt"), "changed\n").unwrap();
    let manager = CaptureManager::default();
    let task = manager.begin("lost-after-publish").unwrap();
    let workspace = create(&storage, request, task, |progress| {
        if progress.phase == "completed" {
            return Err(AppError::new("cancelled", "The capture window was closed."));
        }
        Ok(())
    })
    .unwrap();
    manager.finish("lost-after-publish");
    drop(storage);
    let reopened = Storage::open(dir.path().join("data")).unwrap();
    repositories::open(&reopened, &repo.path).unwrap();
    let reviews = reopened.list::<Review>("review").unwrap();
    let snapshots = reopened.list::<Snapshot>("snapshot").unwrap();
    assert_eq!((reviews.len(), snapshots.len()), (1, 1));
    assert_eq!(reviews[0].id, workspace.review.id);
    assert_eq!(reviews[0].snapshot_id, snapshots[0].id);
}

#[test]
fn submodule_worktree_preview_matches_captured_index_gitlinks() {
    let (dir, storage, repo, request) = fixture();
    let root = Path::new(&repo.path);
    let child = dir.path().join("child");
    fs::create_dir(&child).unwrap();
    git(&child, &["init", "-q"]);
    git(
        &child,
        &["config", "user.email", "reviewbox@example.invalid"],
    );
    git(&child, &["config", "user.name", "ReviewBox test"]);
    fs::write(child.join("child.txt"), "original\n").unwrap();
    git(&child, &["add", "child.txt"]);
    git(
        &child,
        &["-c", "commit.gpgsign=false", "commit", "-qm", "child"],
    );
    git(
        root,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "-q",
            child.to_str().unwrap(),
            "child",
        ],
    );
    git(
        root,
        &["-c", "commit.gpgsign=false", "commit", "-qm", "submodule"],
    );
    fs::write(root.join("child/child.txt"), "dirty child contents\n").unwrap();
    let stats = preview(&storage, &request).unwrap();
    assert_eq!(scope(&stats, Scope::Local).files, 0);
    assert_eq!(scope(&stats, Scope::Unstaged).files, 0);
    assert!(
        snapshots::capture(&storage, request)
            .unwrap()
            .changes
            .is_empty()
    );
}

#[test]
fn post_publication_index_failure_returns_saved_review_and_defers_cache_rebuild() {
    let (dir, storage, repo, request) = fixture();
    fs::write(Path::new(&repo.path).join("a.txt"), "changed\n").unwrap();
    let db = rusqlite::Connection::open(storage.root().join("reviewbox.sqlite3")).unwrap();
    // Existing documents remain indexable, so the failure occurs precisely after
    // the first snapshot is published, not during pre-publication synchronization.
    db.execute_batch("CREATE TRIGGER fail_snapshot_cache BEFORE INSERT ON project_index WHEN NEW.kind = 'snapshot' BEGIN SELECT RAISE(ABORT, 'fixture cache failure'); END;").unwrap();
    let manager = CaptureManager::default();
    let task = manager.begin("index-fails-after-commit").unwrap();
    let workspace = create(&storage, request, task, |_| Ok(())).unwrap();
    manager.finish("index-fails-after-commit");
    let root = Path::new(&repo.path).join(".reviewbox");
    let bundle = root.join(format!(".local/reviews/{}", workspace.review.id));
    let review: serde_json::Value = serde_json::from_slice(
        &fs::read(bundle.join(format!("reviews/{}/review.json", workspace.review.id))).unwrap(),
    )
    .unwrap();
    let snapshot: serde_json::Value = serde_json::from_slice(
        &fs::read(bundle.join(format!("snapshots/{}.json", workspace.snapshot.id))).unwrap(),
    )
    .unwrap();
    assert_eq!(review["data"]["snapshotId"], snapshot["data"]["id"]);
    assert!(
        !root.join(".local/transaction.json").exists(),
        "The authoritative journal must be complete before suppressing an index failure."
    );
    assert!(
        storage
            .list::<Review>("review")
            .unwrap_err()
            .message
            .contains("fixture cache failure"),
        "Reads must surface a persistent cache failure instead of returning stale records."
    );
    db.execute_batch("DROP TRIGGER fail_snapshot_cache;")
        .unwrap();
    let reviews = storage.list::<Review>("review").unwrap();
    assert_eq!(reviews.len(), 1);
    assert_eq!(reviews[0].id, workspace.review.id);
    assert_eq!(storage.list::<Snapshot>("snapshot").unwrap().len(), 1);
    drop(db);
    drop(storage);
    let reopened = Storage::open(dir.path().join("data")).unwrap();
    repositories::open(&reopened, &repo.path).unwrap();
    assert_eq!(reopened.list::<Review>("review").unwrap().len(), 1);
    assert_eq!(reopened.list::<Snapshot>("snapshot").unwrap().len(), 1);
}

#[test]
fn pre_publication_index_failure_still_aborts_without_shared_documents() {
    let (_dir, storage, repo, request) = fixture();
    fs::write(Path::new(&repo.path).join("a.txt"), "changed\n").unwrap();
    let db = rusqlite::Connection::open(storage.root().join("reviewbox.sqlite3")).unwrap();
    db.execute_batch("DELETE FROM project_index; CREATE TRIGGER fail_all_cache BEFORE INSERT ON project_index BEGIN SELECT RAISE(ABORT, 'fixture pre-commit cache failure'); END;").unwrap();
    let manager = CaptureManager::default();
    let task = manager.begin("index-fails-before-commit").unwrap();
    let error = create(&storage, request, task, |_| Ok(())).unwrap_err();
    manager.finish("index-fails-before-commit");
    assert!(error.message.contains("fixture pre-commit cache failure"));
    db.execute_batch("DROP TRIGGER fail_all_cache;").unwrap();
    assert!(storage.list::<Review>("review").unwrap().is_empty());
    assert!(storage.list::<Snapshot>("snapshot").unwrap().is_empty());
}

#[test]
fn oversized_untracked_file_only_blocks_scopes_that_include_its_layer() {
    let (_dir, storage, repo, request) = fixture();
    let root = Path::new(&repo.path);
    fs::write(root.join("a.txt"), "committed change\n").unwrap();
    git(root, &["add", "a.txt"]);
    git(
        root,
        &["-c", "commit.gpgsign=false", "commit", "-qm", "second"],
    );
    fs::write(root.join("a.txt"), "staged change\n").unwrap();
    git(root, &["add", "a.txt"]);
    fs::File::create(root.join("huge-untracked.bin"))
        .unwrap()
        .set_len(snapshots::MAX_FILE + 1)
        .unwrap();
    let request = CaptureRequest {
        include_untracked: true,
        base: Some("HEAD~1".into()),
        target: Some("HEAD".into()),
        ..request
    };
    let preview = preview(&storage, &request).unwrap();
    assert_eq!(preview.untracked_files, 1);
    for affected in [Scope::Local, Scope::Unstaged] {
        assert!(
            scope(&preview, affected)
                .error
                .as_ref()
                .unwrap()
                .contains("64 MiB")
        );
    }
    for available in [Scope::Staged, Scope::Commit, Scope::Range] {
        let stats = scope(&preview, available);
        assert_eq!(stats.files, 1);
        assert!(stats.error.is_none());
    }
    let without = super::preview(
        &storage,
        &CaptureRequest {
            include_untracked: false,
            ..request
        },
    )
    .unwrap();
    assert!(scope(&without, Scope::Local).error.is_none());
    assert_eq!(scope(&without, Scope::Local).files, 1);
    assert!(scope(&without, Scope::Unstaged).error.is_none());
}

#[test]
fn progressive_preview_counts_before_reading_large_contents_and_cancels() {
    let (_dir, storage, repo, mut request) = fixture();
    let root = Path::new(&repo.path);
    fs::write(root.join("a.txt"), "one\nchanged\n").unwrap();
    let file = fs::File::create(root.join("large.txt")).unwrap();
    file.set_len(65 * 1024 * 1024).unwrap();
    request.include_untracked = true;
    let mut memo = std::collections::BTreeMap::new();
    let value = preview_selected(&storage, &request, false, &|| Ok(()), &mut memo).unwrap();
    assert_eq!(scope(&value, Scope::Local).files, 2);
    assert!(!scope(&value, Scope::Local).details_ready);
    assert!(scope(&value, Scope::Local).error.is_none());
    request.scope = Scope::Staged;
    let value = preview_selected(&storage, &request, true, &|| Ok(()), &mut memo).unwrap();
    assert!(scope(&value, Scope::Staged).details_ready);
    assert!(scope(&value, Scope::Staged).error.is_none());
    let error = preview_selected(
        &storage,
        &request,
        true,
        &|| Err(AppError::new("cancelled", "Stopped")),
        &mut memo,
    )
    .unwrap_err();
    assert_eq!(error.code, "cancelled");
}

#[test]
fn preview_shares_identical_committed_statistics() {
    let (_dir, storage, repo, mut request) = fixture();
    let root = Path::new(&repo.path);
    fs::write(root.join("a.txt"), "one\nchanged\nmore\n").unwrap();
    git(root, &["add", "."]);
    git(
        root,
        &["-c", "commit.gpgsign=false", "commit", "-qm", "second"],
    );
    request.scope = Scope::Commit;
    request.base = Some("HEAD~1".into());
    request.target = Some("HEAD".into());
    let mut memo = std::collections::BTreeMap::new();
    let commit = preview_selected(&storage, &request, true, &|| Ok(()), &mut memo).unwrap();
    let entries = memo.len();
    request.scope = Scope::Range;
    let range = preview_selected(&storage, &request, true, &|| Ok(()), &mut memo).unwrap();
    assert_eq!(entries, memo.len());
    assert_eq!(
        scope(&commit, Scope::Commit).additions,
        scope(&range, Scope::Range).additions
    );
    assert_eq!(scope(&commit, Scope::Commit).deletions, 1);
}
