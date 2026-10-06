use super::*;
use crate::{repositories, storage::Storage};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
};

fn run(root: &Path, args: &[&str]) -> String {
    git::text(root, args).unwrap()
}
fn fixture(initial: bool) -> (tempfile::TempDir, PathBuf, Storage, Repository) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("repo");
    fs::create_dir(&root).unwrap();
    run(&root, &["init", "-q", "-b", "main"]);
    run(&root, &["config", "user.name", "ReviewBox Test"]);
    run(&root, &["config", "user.email", "test@example.invalid"]);
    run(&root, &["config", "commit.gpgsign", "false"]);
    let storage = Storage::open(dir.path().join("private")).unwrap();
    let repo = repositories::open(&storage, root.to_str().unwrap()).unwrap();
    fs::write(root.join("a.txt"), "before\r\nlast").unwrap();
    fs::write(root.join("b.txt"), "before\n").unwrap();
    if initial {
        run(&root, &["add", "."]);
        run(&root, &["commit", "-qm", "initial"]);
    }
    (dir, root, storage, repo)
}
fn stage(root: &Path, path: &str) {
    let file = working::files(root)
        .unwrap()
        .into_iter()
        .find(|f| f.path == path)
        .unwrap();
    working::stage(root, path, &file.version, true, &AtomicBool::new(false)).unwrap();
}
fn request(root: &Path, repo: &Repository) -> GitCommitRequest {
    GitCommitRequest {
        operation_id: id(),
        repository_id: repo.id.clone(),
        index_version: working::index_version(root).unwrap(),
        message: None,
    }
}

#[test]
fn whole_file_stage_unstage_preserves_other_index_entries_and_detects_edits() {
    let (_dir, root, _storage, _repo) = fixture(true);
    fs::write(root.join("a.txt"), "staged\r\nlast").unwrap();
    stage(&root, "a.txt");
    fs::write(root.join("a.txt"), "newer\r\nlast").unwrap();
    fs::write(root.join("b.txt"), "other\n").unwrap();
    stage(&root, "b.txt");
    let file = working::files(&root)
        .unwrap()
        .into_iter()
        .find(|f| f.path == "a.txt")
        .unwrap();
    assert!(
        file.staged_status.is_some() && file.unstaged_status.is_some(),
        "{file:?}; status {}",
        run(&root, &["status", "--porcelain=v2"])
    );
    let diff = working::diff(&root, "a.txt", "staged", &file.version).unwrap();
    assert_eq!(diff.content.after.as_deref(), Some("staged\r\nlast"));
    fs::write(root.join("a.txt"), "changed during reading\n").unwrap();
    assert_eq!(
        working::stage(&root, "a.txt", &file.version, true, &AtomicBool::new(false))
            .unwrap_err()
            .code,
        "git_changed"
    );
    let other = run(&root, &["rev-parse", ":b.txt"]);
    stage(&root, "a.txt");
    let file = working::files(&root)
        .unwrap()
        .into_iter()
        .find(|f| f.path == "a.txt")
        .unwrap();
    assert!(file.unstaged_status.is_none());
    working::stage(
        &root,
        "a.txt",
        &file.version,
        false,
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(run(&root, &["rev-parse", ":b.txt"]), other);
    assert_eq!(
        fs::read_to_string(root.join("a.txt")).unwrap(),
        "changed during reading\n"
    );
    assert!(!git::git_path(&root, "index.lock").unwrap().exists());
}
#[test]
fn additions_renames_deletions_binary_and_literal_paths_are_supported() {
    let (_dir, root, _storage, _repo) = fixture(true);
    fs::write(root.join(":(glob)* [x].bin"), [0, 1, 2, 255]).unwrap();
    stage(&root, ":(glob)* [x].bin");
    let binary = working::files(&root)
        .unwrap()
        .into_iter()
        .find(|f| f.path.ends_with(".bin"))
        .unwrap();
    assert!(
        working::diff(&root, &binary.path, "staged", &binary.version)
            .unwrap()
            .change
            .binary
    );
    run(&root, &["mv", "a.txt", "renamed.txt"]);
    let file = working::files(&root)
        .unwrap()
        .into_iter()
        .find(|f| f.path == "renamed.txt")
        .unwrap();
    assert_eq!(file.previous_path.as_deref(), Some("a.txt"));
    working::stage(
        &root,
        &file.path,
        &file.version,
        false,
        &AtomicBool::new(false),
    )
    .unwrap();
    assert!(root.join("renamed.txt").exists());
    assert!(run(&root, &["ls-files", "--", "a.txt"]).contains("a.txt"));
    fs::remove_file(root.join("b.txt")).unwrap();
    stage(&root, "b.txt");
    assert!(run(&root, &["ls-files", "--", "b.txt"]).is_empty());
}
#[test]
fn batches_commit_frozen_index_versions_without_staging_newer_worktree_content() {
    let (_dir, root, storage, repo) = fixture(true);
    fs::write(root.join("a.txt"), "staged A\r\nlast").unwrap();
    fs::write(root.join("b.txt"), "staged B\n").unwrap();
    stage(&root, "a.txt");
    stage(&root, "b.txt");
    let request = request(&root, &repo);
    let frozen = commits::freeze(&root, &request.index_version).unwrap();
    fs::write(root.join("a.txt"), "unstaged A\n").unwrap();
    let batches=commits::plan(r#"{"commits":[{"message":"feat: A","paths":["a.txt"]},{"message":"fix: B","paths":["b.txt"]}]}"#,&frozen).unwrap();
    let result = commits::execute(
        &storage,
        &root,
        &request,
        &frozen,
        batches,
        &AtomicBool::new(false),
        |_| {},
    )
    .unwrap();
    assert_eq!(result.status, "completed", "{:?}", result.error);
    assert_eq!(result.commits.len(), 2);
    assert_eq!(
        git::read(&root, &["show", "HEAD:a.txt"]).unwrap(),
        b"staged A\r\nlast"
    );
    assert_eq!(fs::read(root.join("a.txt")).unwrap(), b"unstaged A\n");
    assert!(run(&root, &["diff", "--cached", "--name-only"]).is_empty());
    assert_eq!(
        history::detail(&root, &result.commits[0].oid)
            .unwrap()
            .files[0]
            .path,
        "a.txt"
    );
    assert_eq!(
        commits::last(&storage, &repo.id)
            .unwrap()
            .unwrap()
            .commits
            .len(),
        2
    );
    assert!(
        commits::plan(
            r#"{"commits":[{"message":"bad","paths":["missing"]}]}"#,
            &frozen
        )
        .is_err()
    );
}
#[test]
fn changed_index_blocks_commit_and_unborn_branch_can_commit() {
    let (_dir, root, storage, repo) = fixture(false);
    stage(&root, "a.txt");
    let request = request(&root, &repo);
    let frozen = commits::freeze(&root, &request.index_version).unwrap();
    stage(&root, "b.txt");
    let batches = vec![commits::Batch {
        message: "initial".into(),
        paths: vec!["a.txt".into()],
    }];
    assert_eq!(
        commits::execute(
            &storage,
            &root,
            &request,
            &frozen,
            batches,
            &AtomicBool::new(false),
            |_| {}
        )
        .unwrap_err()
        .code,
        "git_changed"
    );
    let request = GitCommitRequest {
        index_version: working::index_version(&root).unwrap(),
        ..request
    };
    let frozen = commits::freeze(&root, &request.index_version).unwrap();
    let result = commits::execute(
        &storage,
        &root,
        &request,
        &frozen,
        vec![commits::Batch {
            message: "initial".into(),
            paths: vec!["a.txt".into(), "b.txt".into()],
        }],
        &AtomicBool::new(false),
        |_| {},
    )
    .unwrap();
    assert_eq!(result.status, "completed", "{:?}", result.error);
}
#[cfg(unix)]
#[test]
fn hooks_and_cancellation_keep_completed_commits_and_remaining_staged_changes() {
    use std::os::unix::fs::PermissionsExt;
    let (_dir, root, storage, repo) = fixture(true);
    for path in ["a.txt", "b.txt"] {
        fs::write(root.join(path), "changed\n").unwrap();
        stage(&root, path);
    }
    let hooks = root.join("hooks");
    fs::create_dir(&hooks).unwrap();
    fs::write(hooks.join("pre-commit"), "#!/bin/sh\nexit 1\n").unwrap();
    fs::set_permissions(hooks.join("pre-commit"), fs::Permissions::from_mode(0o755)).unwrap();
    run(
        &root,
        &["config", "core.hooksPath", hooks.to_str().unwrap()],
    );
    let request = request(&root, &repo);
    let frozen = commits::freeze(&root, &request.index_version).unwrap();
    let batches = vec![
        commits::Batch {
            message: "A".into(),
            paths: vec!["a.txt".into()],
        },
        commits::Batch {
            message: "B".into(),
            paths: vec!["b.txt".into()],
        },
    ];
    let result = commits::execute(
        &storage,
        &root,
        &request,
        &frozen,
        batches.clone(),
        &AtomicBool::new(false),
        |_| {},
    )
    .unwrap();
    assert_eq!(result.status, "failed");
    assert!(result.commits.is_empty());
    fs::remove_file(hooks.join("pre-commit")).unwrap();
    let request = GitCommitRequest {
        operation_id: id(),
        ..request
    };
    let cancel = AtomicBool::new(false);
    let result = commits::execute(
        &storage,
        &root,
        &request,
        &frozen,
        batches,
        &cancel,
        |state| {
            if state.commits.len() == 1 {
                cancel.store(true, Ordering::Relaxed);
            }
        },
    )
    .unwrap();
    assert_eq!(result.status, "cancelled");
    assert_eq!(result.commits.len(), 1);
    assert_eq!(run(&root, &["diff", "--cached", "--name-only"]), "b.txt");
}
#[test]
fn publish_push_fetch_and_behind_guard_use_a_real_local_remote() {
    let (dir, root, _storage, repo) = fixture(true);
    let remote = dir.path().join("remote.git");
    fs::create_dir(&remote).unwrap();
    run(&remote, &["init", "--bare", "-q"]);
    run(
        &root,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    let manager = SourceControl::default();
    let cancel = AtomicBool::new(false);
    history::push(&manager, &root, "main", None, &cancel).unwrap();
    assert_eq!(
        run(&root, &["rev-parse", "--abbrev-ref", "@{upstream}"]),
        "origin/main"
    );
    let clone = dir.path().join("other");
    run(
        dir.path(),
        &[
            "clone",
            "-q",
            "--branch",
            "main",
            remote.to_str().unwrap(),
            clone.to_str().unwrap(),
        ],
    );
    run(&clone, &["config", "user.name", "Other"]);
    run(&clone, &["config", "user.email", "other@example.invalid"]);
    run(&clone, &["config", "commit.gpgsign", "false"]);
    fs::write(clone.join("remote.txt"), "remote\n").unwrap();
    run(&clone, &["add", "remote.txt"]);
    run(&clone, &["commit", "-qm", "remote change"]);
    run(&clone, &["push", "-q", "origin", "main"]);
    assert_eq!(
        history::push(&manager, &root, "main", None, &cancel)
            .unwrap_err()
            .code,
        "git_behind"
    );
    let state = history::state(&manager, &root, &repo.id).unwrap();
    assert_eq!(state.behind, 1);
    assert!(state.blocked_reason.is_some());
    assert!(!state.remote_commits.is_empty());
}

#[test]
fn reading_local_git_includes_shared_metadata_but_never_creates_a_review() {
    let (_dir, root, storage, repo) = fixture(true);
    fs::write(root.join(".reviewbox/visible.txt"), "shared\n").unwrap();
    fs::create_dir_all(root.join(".reviewbox/.local")).unwrap();
    fs::write(root.join(".reviewbox/.local/private.txt"), "private\n").unwrap();
    let before = fs::read(git::git_path(&root, "index").unwrap()).unwrap();
    let state = history::state(&SourceControl::default(), &root, &repo.id).unwrap();
    assert!(
        state
            .files
            .iter()
            .any(|f| f.path == ".reviewbox/visible.txt")
    );
    assert!(!state.files.iter().any(|f| f.path.contains("private.txt")));
    assert_eq!(
        fs::read(git::git_path(&root, "index").unwrap()).unwrap(),
        before
    );
    assert!(storage.list::<Review>("review").unwrap().is_empty());
}

#[test]
fn code_explain_reads_private_sources_and_glossary_save_preserves_documents() {
    let (dir, root, storage, repo) = fixture(true);
    let storage = storage.scoped(Some(&repo.id));
    let mut snapshot = crate::snapshots::prepare_capture(
        &storage,
        CaptureRequest {
            repository_id: repo.id.clone(),
            scope: Scope::Local,
            base: None,
            target: None,
            include_untracked: true,
        },
        &mut |_, _, _, _| Ok(()),
    )
    .unwrap();
    snapshot.id = format!("source-{}", id());
    storage.store_context(&snapshot).unwrap();
    assert!(storage.list::<Review>("review").unwrap().is_empty());
    let mut knowledge = crate::knowledge::load(&storage, &repo.id).unwrap();
    knowledge.documents.push(ExplanationDocument {
        id: id(),
        repository_id: repo.id.clone(),
        snapshot_id: snapshot.id.clone(),
        path: "a.txt".into(),
        fingerprint: snapshot
            .files
            .iter()
            .find(|f| f.path == "a.txt")
            .unwrap()
            .content
            .hash
            .clone(),
        language: knowledge.language.clone(),
        sections: vec![ExplanationSection {
            id: id(),
            title: "Existing explanation".into(),
            body: "Saved before removal.".into(),
            start_line: 1,
            end_line: 2,
        }],
        occurrences: vec![],
        created_at: now(),
    });
    let mut knowledge = crate::knowledge::save(&storage, knowledge).unwrap();
    let documents = serde_json::to_value(&knowledge.documents).unwrap();
    knowledge.terms.push(GlossaryTerm {
        id: id(),
        term: "Value".into(),
        aliases: vec![],
        senses: vec![Sense {
            id: id(),
            description: "A stored value.".into(),
        }],
        archived: false,
    });
    let knowledge = crate::knowledge::save(&storage, knowledge).unwrap();
    assert_eq!(
        serde_json::to_value(&knowledge.documents).unwrap(),
        documents
    );
    assert_eq!(knowledge.terms.len(), 1);
    storage.release_context(&snapshot.id).unwrap();
    fs::remove_dir_all(dir.path().join("private/blobs")).unwrap();
    fs::create_dir(dir.path().join("private/blobs")).unwrap();
    let saved: Snapshot = storage.get("snapshot", &snapshot.id).unwrap();
    let source = saved.files.iter().find(|f| f.path == "a.txt").unwrap();
    assert_eq!(
        storage.read_blob(&source.content.hash).unwrap(),
        b"before\r\nlast"
    );
    fs::write(root.join("a.txt"), "new source\n").unwrap();
    assert!(crate::snapshots::repository_changed(&storage, &snapshot).unwrap());
}

#[test]
fn mutations_are_serialized_and_cancellation_is_scoped_to_the_operation() {
    let manager = SourceControl::default();
    let first = manager.begin(Path::new("first"), "one").unwrap();
    assert!(manager.begin(Path::new("first"), "two").is_err());
    let second = manager.begin(Path::new("second"), "two").unwrap();
    manager.cancel("one");
    assert!(first.cancel.load(Ordering::Relaxed));
    assert!(!second.cancel.load(Ordering::Relaxed));
    drop(first);
    assert!(manager.begin(Path::new("first"), "three").is_ok());
    manager.stop_all();
    assert!(second.cancel.load(Ordering::Relaxed));
}

#[cfg(unix)]
#[test]
fn only_dead_reviewbox_index_reservations_are_recovered() {
    let (_dir, root, _storage, _repo) = fixture(true);
    let lock = git::git_path(&root, "index.lock").unwrap();
    fs::write(&lock, "foreign Git lock").unwrap();
    assert!(git::IndexLock::acquire(&root).is_err());
    assert_eq!(fs::read_to_string(&lock).unwrap(), "foreign Git lock");
    fs::remove_file(&lock).unwrap();
    let mut child = std::process::Command::new("/bin/sh")
        .args(["-c", "exit 0"])
        .spawn()
        .unwrap();
    let pid = child.id();
    child.wait().unwrap();
    fs::write(&lock, format!("ReviewBox index lock v1 {pid} {}\n", id())).unwrap();
    let owned = git::IndexLock::acquire(&root).unwrap();
    assert!(git::IndexLock::acquire(&root).is_err());
    // Even a replaced lock is not ours to remove.
    fs::rename(&lock, root.join("owned.lock")).unwrap();
    fs::write(&lock, "new foreign lock").unwrap();
    drop(owned);
    assert_eq!(fs::read_to_string(lock).unwrap(), "new foreign lock");
}

#[test]
fn restart_discovers_a_completed_commit_without_replaying_it() {
    let (_dir, root, storage, repo) = fixture(true);
    fs::write(root.join("a.txt"), "changed\n").unwrap();
    stage(&root, "a.txt");
    let request = request(&root, &repo);
    let frozen = commits::freeze(&root, &request.index_version).unwrap();
    let result = commits::execute(
        &storage,
        &root,
        &request,
        &frozen,
        vec![commits::Batch {
            message: "one".into(),
            paths: vec!["a.txt".into()],
        }],
        &AtomicBool::new(false),
        |_| {},
    )
    .unwrap();
    let head = git::head(&root).unwrap();
    let path = storage.root().join("git-operations").join(format!(
        "{}.json",
        fingerprint(request.operation_id.as_bytes())
    ));
    let mut journal: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    // Model the crash between Git's ref update and the journal write.
    journal["operation"]["status"] = "running".into();
    journal["operation"]["commits"] = serde_json::json!([]);
    journal["pending_head"] = serde_json::json!(frozen.head);
    journal["pending_tree"] = serde_json::json!(run(&root, &["rev-parse", "HEAD^{tree}"]));
    fs::write(path, serde_json::to_vec(&journal).unwrap()).unwrap();
    let recovered = commits::last(&storage, &repo.id).unwrap().unwrap();
    assert_eq!(recovered.status, "interrupted");
    assert_eq!(recovered.commits[0].oid, result.commits[0].oid);
    assert_eq!(git::head(&root).unwrap(), head);
    assert_eq!(
        commits::last(&storage, &repo.id)
            .unwrap()
            .unwrap()
            .commits
            .len(),
        1
    );
}

#[cfg(unix)]
#[test]
fn signing_failure_is_not_bypassed() {
    use std::os::unix::fs::PermissionsExt;
    let (dir, root, storage, repo) = fixture(true);
    let signer = dir.path().join("failing-signer");
    fs::write(
        &signer,
        "#!/bin/sh\necho 'signing unavailable' >&2\nexit 1\n",
    )
    .unwrap();
    fs::set_permissions(&signer, fs::Permissions::from_mode(0o755)).unwrap();
    run(&root, &["config", "gpg.format", "openpgp"]);
    run(&root, &["config", "gpg.program", signer.to_str().unwrap()]);
    run(&root, &["config", "commit.gpgsign", "true"]);
    run(&root, &["config", "user.signingkey", "test-key"]);
    fs::write(root.join("a.txt"), "changed\n").unwrap();
    stage(&root, "a.txt");
    let request = request(&root, &repo);
    let frozen = commits::freeze(&root, &request.index_version).unwrap();
    let result = commits::execute(
        &storage,
        &root,
        &request,
        &frozen,
        vec![commits::Batch {
            message: "one".into(),
            paths: vec!["a.txt".into()],
        }],
        &AtomicBool::new(false),
        |_| {},
    )
    .unwrap();
    assert_eq!(result.status, "failed");
    assert!(result.error.unwrap().contains("sign"));
    assert!(result.commits.is_empty());
    assert_eq!(git::head(&root), frozen.head);
    assert_eq!(run(&root, &["diff", "--cached", "--name-only"]), "a.txt");
}

#[test]
fn remote_failures_preserve_last_state_and_divergence_or_merge_blocks_push() {
    let (dir, root, _storage, repo) = fixture(true);
    let remote = dir.path().join("remote.git");
    fs::create_dir(&remote).unwrap();
    run(&remote, &["init", "--bare", "-q"]);
    run(
        &root,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    run(
        &root,
        &["remote", "add", "secondary", remote.to_str().unwrap()],
    );
    let manager = SourceControl::default();
    let cancel = AtomicBool::new(false);
    assert_eq!(
        history::push(&manager, &root, "main", None, &cancel)
            .unwrap_err()
            .code,
        "remote_required"
    );
    run(&root, &["branch", "other-branch"]);
    run(&root, &["tag", "-a", "not-for-push", "-m", "tag"]);
    run(&root, &["config", "push.followTags", "true"]);
    history::push(&manager, &root, "main", Some("origin"), &cancel).unwrap();
    assert_eq!(
        run(&remote, &["for-each-ref", "--format=%(refname)"]),
        "refs/heads/main"
    );
    let clone = dir.path().join("clone");
    run(
        dir.path(),
        &[
            "clone",
            "-q",
            "-b",
            "main",
            remote.to_str().unwrap(),
            clone.to_str().unwrap(),
        ],
    );
    for key in ["user.name", "user.email"] {
        run(&clone, &["config", key, "fixture@example.invalid"]);
    }
    run(&clone, &["config", "commit.gpgsign", "false"]);
    fs::write(clone.join("remote"), "new").unwrap();
    run(&clone, &["add", "remote"]);
    run(&clone, &["commit", "-qm", "remote"]);
    run(&clone, &["push", "-q", "origin", "main"]);
    fs::write(root.join("local"), "new").unwrap();
    run(&root, &["add", "local"]);
    run(&root, &["commit", "-qm", "local"]);
    assert_eq!(
        history::push(&manager, &root, "main", None, &cancel)
            .unwrap_err()
            .code,
        "git_behind"
    );
    let state = history::state(&manager, &root, &repo.id).unwrap();
    assert_eq!((state.ahead, state.behind), (1, 1));
    fs::write(
        git::git_path(&root, "MERGE_HEAD").unwrap(),
        git::head(&root).unwrap(),
    )
    .unwrap();
    assert_eq!(
        history::push(&manager, &root, "main", None, &cancel)
            .unwrap_err()
            .code,
        "git_conflict"
    );
    fs::remove_file(git::git_path(&root, "MERGE_HEAD").unwrap()).unwrap();
    let checked_at = manager.remote_check(&root).checked_at;
    run(
        &root,
        &[
            "remote",
            "set-url",
            "origin",
            dir.path().join("missing").to_str().unwrap(),
        ],
    );
    assert!(history::fetch(&manager, &root, true, &cancel).is_err());
    let failed = history::state(&manager, &root, &repo.id).unwrap();
    assert_eq!(failed.remote_check.checked_at, checked_at);
    assert!(failed.remote_check.error.is_some());
    assert_eq!((failed.ahead, failed.behind), (1, 1));
    assert_eq!(failed.remote_commits[0].oid, state.remote_commits[0].oid);
    assert!(history::push(&manager, &root, "main", None, &cancel).is_err());
}

#[test]
fn staging_a_renamed_destination_does_not_add_a_recreated_old_path() {
    let (_dir, root, _storage, _repo) = fixture(true);
    run(&root, &["mv", "a.txt", "renamed.txt"]);
    fs::write(root.join("a.txt"), "a new unrelated file\n").unwrap();
    fs::write(root.join("renamed.txt"), "changed destination\n").unwrap();
    stage(&root, "renamed.txt");
    assert!(run(&root, &["ls-files", "--", "a.txt"]).is_empty());
    assert_eq!(
        fs::read_to_string(root.join("a.txt")).unwrap(),
        "a new unrelated file\n"
    );
    assert_eq!(
        git::read(&root, &["show", ":renamed.txt"]).unwrap(),
        b"changed destination\n"
    );
}

#[test]
fn switching_to_another_branch_at_the_same_commit_invalidates_the_commit_view() {
    let (_dir, root, _storage, _repo) = fixture(true);
    fs::write(root.join("a.txt"), "changed\n").unwrap();
    stage(&root, "a.txt");
    let before = working::index_version(&root).unwrap();
    run(&root, &["checkout", "-qb", "another"]);
    assert_eq!(
        commits::freeze(&root, &before).err().unwrap().code,
        "git_changed"
    );
}

#[cfg(unix)]
#[test]
fn index_writing_hooks_cannot_silently_add_unstaged_files_to_a_batch() {
    use std::os::unix::fs::PermissionsExt;
    let (_dir, root, storage, repo) = fixture(true);
    fs::write(root.join("a.txt"), "staged\n").unwrap();
    fs::write(root.join("extra.txt"), "unstaged\n").unwrap();
    stage(&root, "a.txt");
    let request = request(&root, &repo);
    let frozen = commits::freeze(&root, &request.index_version).unwrap();
    let hooks = root.join("hooks");
    fs::create_dir(&hooks).unwrap();
    fs::write(
        hooks.join("post-index-change"),
        "#!/bin/sh\nif [ -z \"$IN_HOOK\" ]; then IN_HOOK=1 git add -- extra.txt; fi\n",
    )
    .unwrap();
    fs::set_permissions(
        hooks.join("post-index-change"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    run(
        &root,
        &["config", "core.hooksPath", hooks.to_str().unwrap()],
    );
    let result = commits::execute(
        &storage,
        &root,
        &request,
        &frozen,
        vec![commits::Batch {
            message: "one".into(),
            paths: vec!["a.txt".into()],
        }],
        &AtomicBool::new(false),
        |_| {},
    )
    .unwrap();
    assert_eq!(result.status, "failed");
    assert!(
        result
            .error
            .as_ref()
            .is_some_and(|error| error.contains("personal changes")),
        "{:?}",
        result.error
    );
    assert_eq!(result.commits.len(), 1);
    assert_ne!(git::head(&root), frozen.head);
    assert_eq!(
        fs::read_to_string(root.join("extra.txt")).unwrap(),
        "unstaged\n"
    );
}

fn selections(root: &Path, paths: &[&str]) -> Vec<LocalFileSelection> {
    working::files(root)
        .unwrap()
        .into_iter()
        .filter(|f| paths.contains(&f.path.as_str()))
        .map(|f| LocalFileSelection {
            path: f.path,
            version: f.version,
        })
        .collect()
}

#[test]
fn batch_stage_and_unstage_preserve_worktree_and_reject_stale_selection() {
    let (_dir, root, _, _) = fixture(true);
    fs::write(root.join("a.txt"), "new a").unwrap();
    fs::write(root.join("b.txt"), "new b").unwrap();
    let selected = selections(&root, &["a.txt", "b.txt"]);
    fs::write(root.join("b.txt"), "newer b").unwrap();
    let cancel = AtomicBool::new(false);
    assert!(working::stage_files(&root, &selected, true, &cancel).is_err());
    assert!(run(&root, &["diff", "--cached", "--name-only"]).is_empty());
    working::stage_files(
        &root,
        &selections(&root, &["a.txt", "b.txt"]),
        true,
        &cancel,
    )
    .unwrap();
    assert_eq!(
        run(&root, &["diff", "--cached", "--name-only"]),
        "a.txt\nb.txt"
    );
    working::stage_files(
        &root,
        &selections(&root, &["a.txt", "b.txt"]),
        false,
        &cancel,
    )
    .unwrap();
    assert!(run(&root, &["diff", "--cached", "--name-only"]).is_empty());
    assert_eq!(fs::read_to_string(root.join("b.txt")).unwrap(), "newer b");
}

#[test]
fn discard_only_unstaged_preserves_index_and_unselected_files() {
    let (_dir, root, _, _) = fixture(true);
    fs::write(root.join("a.txt"), b"staged\0binary").unwrap();
    stage(&root, "a.txt");
    fs::write(root.join("a.txt"), b"unstaged\0binary").unwrap();
    fs::write(root.join("b.txt"), "leave me").unwrap();
    fs::write(root.join("new.txt"), "delete me").unwrap();
    let index = fs::read(git::git_path(&root, "index").unwrap()).unwrap();
    working::discard_files(
        &root,
        &selections(&root, &["a.txt", "new.txt"]),
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(fs::read(root.join("a.txt")).unwrap(), b"staged\0binary");
    assert!(!root.join("new.txt").exists());
    assert_eq!(fs::read_to_string(root.join("b.txt")).unwrap(), "leave me");
    assert_eq!(
        fs::read(git::git_path(&root, "index").unwrap()).unwrap(),
        index
    );
}

#[test]
fn discard_rejects_stale_batch_before_restoring_any_file() {
    let (_dir, root, _, _) = fixture(true);
    fs::remove_file(root.join("a.txt")).unwrap();
    fs::write(root.join("b.txt"), "modified").unwrap();
    let selected = selections(&root, &["a.txt", "b.txt"]);
    fs::write(root.join("b.txt"), "newer").unwrap();
    assert!(working::discard_files(&root, &selected, &AtomicBool::new(false)).is_err());
    assert!(!root.join("a.txt").exists());
    working::discard_files(
        &root,
        &selections(&root, &["a.txt"]),
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(fs::read(root.join("a.txt")).unwrap(), b"before\r\nlast");
    assert_eq!(fs::read_to_string(root.join("b.txt")).unwrap(), "newer");
}

#[test]
fn branch_switch_lists_exact_local_refs_and_preserves_changes() {
    let (_dir, root, _storage, _repo) = fixture(true);
    run(&root, &["branch", "feature/example"]);
    assert_eq!(
        branches::list(&root).unwrap(),
        vec!["feature/example", "main"]
    );
    fs::write(root.join("b.txt"), "local changes\n").unwrap();
    branches::switch(&root, "feature/example", &AtomicBool::new(false)).unwrap();
    assert_eq!(run(&root, &["branch", "--show-current"]), "feature/example");
    assert_eq!(
        fs::read_to_string(root.join("b.txt")).unwrap(),
        "local changes\n"
    );
    for invalid in ["--detach", "HEAD~1", "@{-1}", "missing"] {
        assert!(branches::switch(&root, invalid, &AtomicBool::new(false)).is_err());
    }
}

#[test]
fn branch_switch_refuses_overwrites_and_keeps_index() {
    let (_dir, root, _storage, _repo) = fixture(true);
    run(&root, &["switch", "-c", "other"]);
    fs::write(root.join("a.txt"), "other branch\n").unwrap();
    run(&root, &["commit", "-am", "other"]);
    run(&root, &["switch", "main"]);
    fs::write(root.join("a.txt"), "local edit\n").unwrap();
    stage(&root, "a.txt");
    let index = run(&root, &["write-tree"]);
    assert!(branches::switch(&root, "other", &AtomicBool::new(false)).is_err());
    assert_eq!(run(&root, &["branch", "--show-current"]), "main");
    assert_eq!(run(&root, &["write-tree"]), index);
    assert_eq!(
        fs::read_to_string(root.join("a.txt")).unwrap(),
        "local edit\n"
    );
}

#[test]
fn commit_context_contains_only_frozen_git_references_even_for_large_changes() {
    for initial in [false, true] {
        let (_dir, root, _storage, repo) = fixture(initial);
        let content = "staged payload only\n".repeat(70_000);
        fs::write(root.join("a.txt"), &content).unwrap();
        stage(&root, "a.txt");
        let request = request(&root, &repo);
        let frozen = commits::freeze(&root, &request.index_version).unwrap();
        assert_eq!(
            working::index_version(&root).unwrap(),
            request.index_version
        );
        assert!(frozen.context.len() < 4096);
        assert!(!frozen.context.contains("staged payload"));
        let context: serde_json::Value = serde_json::from_str(&frozen.context).unwrap();
        assert!(context.get("stagedDiff").is_none());
        let tree = context["stagedTree"].as_str().unwrap();
        fs::write(root.join("a.txt"), "newer staged content").unwrap();
        stage(&root, "a.txt");
        assert_eq!(
            git::read(&root, &["show", &format!("{tree}:a.txt")]).unwrap(),
            content.as_bytes()
        );
        let base = context["baseTree"].as_str().unwrap();
        let paths = run(&root, &["diff", "--name-only", base, tree]);
        assert!(paths.lines().any(|p| p == "a.txt"));
        if !initial {
            assert!(run(&root, &["ls-tree", base]).is_empty());
        }
    }
}

#[cfg(unix)]
fn install_commit_hook(root: &Path, name: &str, body: &str) {
    use std::os::unix::fs::PermissionsExt;
    let hooks = git::git_path(root, "hooks").unwrap();
    fs::create_dir_all(&hooks).unwrap();
    let path = hooks.join(name);
    fs::write(&path, format!("#!/bin/sh\nset -e\n{body}\n")).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

#[cfg(unix)]
#[test]
fn formatting_hooks_continue_without_duplicate_or_stale_index() {
    let (_dir, root, storage, repo) = fixture(true);
    fs::write(root.join("a.txt"), "raw\n").unwrap();
    fs::write(root.join("b.txt"), "second\n").unwrap();
    stage(&root, "a.txt");
    stage(&root, "b.txt");
    install_commit_hook(
        &root,
        "pre-commit",
        "printf 'formatted\\n' > a.txt\ngit add -- a.txt",
    );
    let request = request(&root, &repo);
    let frozen = commits::freeze(&root, &request.index_version).unwrap();
    let result = commits::execute(
        &storage,
        &root,
        &request,
        &frozen,
        vec![
            commits::Batch {
                message: "first".into(),
                paths: vec!["a.txt".into()],
            },
            commits::Batch {
                message: "second".into(),
                paths: vec!["b.txt".into()],
            },
        ],
        &AtomicBool::new(false),
        |_| {},
    )
    .unwrap();
    assert_eq!(result.status, "completed", "{:?}", result.error);
    assert_eq!(result.commits.len(), 2);
    assert_eq!(run(&root, &["show", "HEAD:a.txt"]), "formatted");
    assert!(run(&root, &["status", "--porcelain"]).is_empty());
}

#[cfg(unix)]
#[test]
fn residual_hook_output_gets_one_extra_commit_and_updates_later_batch() {
    let (_dir, root, storage, repo) = fixture(true);
    fs::write(root.join("a.txt"), "first\n").unwrap();
    fs::write(root.join("b.txt"), "second\n").unwrap();
    stage(&root, "a.txt");
    stage(&root, "b.txt");
    install_commit_hook(
        &root,
        "post-commit",
        "printf 'formatted\\n' > b.txt\nprintf 'generated\\n' > generated.txt",
    );
    let request = request(&root, &repo);
    let frozen = commits::freeze(&root, &request.index_version).unwrap();
    let result = commits::execute(
        &storage,
        &root,
        &request,
        &frozen,
        vec![
            commits::Batch {
                message: "first".into(),
                paths: vec!["a.txt".into()],
            },
            commits::Batch {
                message: "second".into(),
                paths: vec!["b.txt".into()],
            },
        ],
        &AtomicBool::new(false),
        |_| {},
    )
    .unwrap();
    assert_eq!(result.status, "completed", "{:?}", result.error);
    assert_eq!(result.commits.len(), 2);
    assert_eq!(result.commits[1].subject, "chore: apply git hook changes");
    assert_eq!(run(&root, &["show", "HEAD:b.txt"]), "formatted");
    assert!(run(&root, &["status", "--porcelain"]).is_empty());
}

#[cfg(unix)]
#[test]
fn hook_overlap_preserves_personal_work_and_stops() {
    let (_dir, root, storage, repo) = fixture(true);
    fs::write(root.join("a.txt"), "staged\n").unwrap();
    stage(&root, "a.txt");
    fs::write(root.join("b.txt"), "personal\n").unwrap();
    install_commit_hook(&root, "post-commit", "printf 'hook\\n' >> b.txt");
    let request = request(&root, &repo);
    let frozen = commits::freeze(&root, &request.index_version).unwrap();
    let result = commits::execute(
        &storage,
        &root,
        &request,
        &frozen,
        vec![commits::Batch {
            message: "first".into(),
            paths: vec!["a.txt".into()],
        }],
        &AtomicBool::new(false),
        |_| {},
    )
    .unwrap();
    assert_eq!(result.status, "failed");
    assert!(result.error.unwrap().contains("personal changes"));
    assert_eq!(result.commits.len(), 1);
    assert_eq!(
        fs::read_to_string(root.join("b.txt")).unwrap(),
        "personal\nhook\n"
    );
    assert_eq!(run(&root, &["show", "HEAD:b.txt"]), "before");
}

#[cfg(unix)]
#[test]
fn unstable_hook_is_bounded_and_leaves_residual_staged() {
    let (_dir, root, storage, repo) = fixture(true);
    fs::write(root.join("a.txt"), "staged\n").unwrap();
    stage(&root, "a.txt");
    install_commit_hook(&root, "post-commit", "printf 'hook\\n' >> a.txt");
    let request = request(&root, &repo);
    let frozen = commits::freeze(&root, &request.index_version).unwrap();
    let result = commits::execute(
        &storage,
        &root,
        &request,
        &frozen,
        vec![commits::Batch {
            message: "first".into(),
            paths: vec!["a.txt".into()],
        }],
        &AtomicBool::new(false),
        |_| {},
    )
    .unwrap();
    assert_eq!(result.status, "failed");
    assert!(result.error.unwrap().contains("still changes files"));
    assert_eq!(result.commits.len(), 2);
    assert_eq!(run(&root, &["diff", "--cached", "--name-only"]), "a.txt");
    assert!(run(&root, &["diff", "--name-only"]).is_empty());
}

#[cfg(unix)]
#[test]
fn restart_recovers_hook_changed_commit_and_reconciles_original_index() {
    let (_dir, root, storage, repo) = fixture(true);
    fs::write(root.join("a.txt"), "raw\n").unwrap();
    stage(&root, "a.txt");
    let index_path = git::git_path(&root, "index").unwrap();
    let planned_tree = run(&root, &["write-tree"]);
    let original_index = fs::read(&index_path).unwrap();
    install_commit_hook(
        &root,
        "pre-commit",
        "printf 'formatted\\n' > a.txt\ngit add -- a.txt",
    );
    let request = request(&root, &repo);
    let frozen = commits::freeze(&root, &request.index_version).unwrap();
    let result = commits::execute(
        &storage,
        &root,
        &request,
        &frozen,
        vec![commits::Batch {
            message: "first".into(),
            paths: vec!["a.txt".into()],
        }],
        &AtomicBool::new(false),
        |_| {},
    )
    .unwrap();
    assert_eq!(result.status, "completed");
    let path = storage.root().join("git-operations").join(format!(
        "{}.json",
        fingerprint(request.operation_id.as_bytes())
    ));
    let mut journal: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    journal["operation"]["status"] = "running".into();
    journal["operation"]["commits"] = serde_json::json!([]);
    journal["pending_head"] = serde_json::json!(frozen.head);
    journal["pending_tree"] = planned_tree.clone().into();
    journal["target_tree"] = planned_tree.into();
    fs::write(&path, serde_json::to_vec(&journal).unwrap()).unwrap();
    fs::write(index_path, original_index).unwrap();
    let recovered = commits::last(&storage, &repo.id).unwrap().unwrap();
    assert_eq!(recovered.commits.len(), 1);
    assert_eq!(recovered.commits[0].oid, result.commits[0].oid);
    assert!(run(&root, &["status", "--porcelain"]).is_empty());
}

#[cfg(unix)]
#[test]
fn failed_hook_preserves_modified_index_without_retrying() {
    let (_dir, root, storage, repo) = fixture(true);
    fs::write(root.join("a.txt"), "raw\n").unwrap();
    stage(&root, "a.txt");
    install_commit_hook(
        &root,
        "pre-commit",
        "printf 'formatted\\n' > a.txt\ngit add -- a.txt\nexit 1",
    );
    let request = request(&root, &repo);
    let frozen = commits::freeze(&root, &request.index_version).unwrap();
    let result = commits::execute(
        &storage,
        &root,
        &request,
        &frozen,
        vec![commits::Batch {
            message: "first".into(),
            paths: vec!["a.txt".into()],
        }],
        &AtomicBool::new(false),
        |_| {},
    )
    .unwrap();
    assert_eq!(result.status, "failed");
    assert!(result.commits.is_empty());
    assert_eq!(git::head(&root), frozen.head);
    assert_eq!(run(&root, &["show", ":a.txt"]), "formatted");
    assert!(run(&root, &["diff", "--name-only"]).is_empty());
}
