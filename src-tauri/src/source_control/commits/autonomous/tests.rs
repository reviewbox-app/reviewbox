use super::*;
use std::sync::Mutex;

fn git(root: &Path, args: &[&str]) -> String {
    git::text(root, args).unwrap()
}
fn fixture(initial: bool) -> (tempfile::TempDir, PathBuf, Storage, GitCommitRequest) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("repo");
    fs::create_dir(&root).unwrap();
    git(&root, &["init", "-q", "-b", "main"]);
    git(&root, &["config", "user.name", "Test"]);
    git(&root, &["config", "user.email", "test@example.invalid"]);
    git(&root, &["config", "commit.gpgsign", "false"]);
    if initial {
        commit(&root, "initial");
    }
    let storage = Storage::open(dir.path().join("private")).unwrap();
    fs::write(root.join(".git/info/exclude"), ".reviewbox/\n").unwrap();
    let repo = crate::repositories::open(&storage, root.to_str().unwrap()).unwrap();
    let request = GitCommitRequest {
        operation_id: id(),
        repository_id: repo.id,
        index_version: String::new(),
        message: None,
    };
    (dir, root, storage, request)
}
fn commit(root: &Path, name: &str) {
    fs::write(root.join(name), name).unwrap();
    git(root, &["add", name]);
    git(root, &["commit", "-qm", name]);
}

#[tokio::test]
async fn streams_real_commits_before_provider_finishes_and_captures_final_commit() {
    let (_dir, root, storage, request) = fixture(true);
    let updates = Mutex::new(Vec::new());
    let result = monitor(
        &storage,
        &root,
        &request,
        Arc::new(AtomicBool::new(false)),
        |s| {
            updates
                .lock()
                .unwrap()
                .push((s.status.clone(), s.commits.len()))
        },
        async {
            commit(&root, "first");
            tokio::time::sleep(Duration::from_millis(1100)).await;
            assert!(
                updates
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|(s, n)| s == "running" && *n == 1)
            );
            commit(&root, "second");
            Ok(())
        },
    )
    .await
    .unwrap();
    assert_eq!(result.status, "completed");
    assert_eq!(
        result
            .commits
            .iter()
            .map(|c| c.subject.as_str())
            .collect::<Vec<_>>(),
        ["first", "second"]
    );
    assert!(git(&root, &["status", "--porcelain"]).is_empty());
    assert_eq!(
        last(&storage, &request.repository_id)
            .unwrap()
            .unwrap()
            .commits
            .len(),
        2
    );
}

#[tokio::test]
async fn partial_provider_failure_preserves_commit_staging_and_details() {
    let (_dir, root, storage, request) = fixture(false);
    let result = monitor(
        &storage,
        &root,
        &request,
        Arc::new(AtomicBool::new(false)),
        |_| {},
        async {
            commit(&root, "first");
            fs::write(root.join("pending"), "pending").unwrap();
            git(&root, &["add", "pending"]);
            Err(AppError::new("provider_error", "Hook failed").with_details("specific failure"))
        },
    )
    .await
    .unwrap();
    assert_eq!(result.status, "failed");
    assert_eq!(result.commits.len(), 1);
    assert!(result.error.unwrap().contains("specific failure"));
    assert_eq!(git(&root, &["diff", "--cached", "--name-only"]), "pending");
    assert_eq!(git(&root, &["log", "-1", "--format=%s"]), "first");
}

#[tokio::test]
async fn cancellation_keeps_observed_commits_and_waits_for_execution_cleanup() {
    let (_dir, root, storage, request) = fixture(true);
    let cancel = Arc::new(AtomicBool::new(false));
    let cleaned = AtomicBool::new(false);
    let result = monitor(&storage, &root, &request, cancel.clone(), |_| {}, async {
        commit(&root, "first");
        cancel.store(true, Ordering::Relaxed);
        tokio::time::sleep(Duration::from_millis(30)).await;
        cleaned.store(true, Ordering::Relaxed);
        Err(AppError::new("cancelled", "Stopped"))
    })
    .await
    .unwrap();
    assert!(cleaned.load(Ordering::Relaxed));
    assert_eq!(result.status, "cancelled");
    assert_eq!(result.commits.len(), 1);
}

#[test]
fn restart_recovers_unobserved_commits_without_touching_index_or_old_branch_history() {
    let (_dir, root, storage, request) = fixture(true);
    git(&root, &["checkout", "-qb", "other"]);
    commit(&root, "preexisting");
    git(&root, &["checkout", "-q", "main"]);
    let mut journal = begin(&storage, &root, &request).unwrap();
    git(&root, &["checkout", "-q", "other"]);
    observe(&root, &mut journal).unwrap();
    assert!(journal.operation.commits.is_empty());
    commit(&root, "new");
    let index = fs::read(root.join(".git/index")).unwrap();
    let recovered = last(&storage, &request.repository_id).unwrap().unwrap();
    assert_eq!(recovered.status, "interrupted");
    assert_eq!(recovered.commits.len(), 1);
    assert_eq!(recovered.commits[0].subject, "new");
    dismiss(&storage, &request.repository_id).unwrap();
    assert!(last(&storage, &request.repository_id).unwrap().is_none());
    assert_eq!(fs::read(root.join(".git/index")).unwrap(), index);
}

#[cfg(unix)]
#[tokio::test]
async fn provider_git_runs_hooks_and_failure_does_not_invent_a_commit() {
    use std::os::unix::fs::PermissionsExt;
    let (_dir, root, storage, request) = fixture(true);
    let hook = root.join(".git/hooks/pre-commit");
    fs::write(&hook, "#!/bin/sh\necho hook-blocked >&2\nexit 1\n").unwrap();
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    fs::write(root.join("pending"), "pending").unwrap();
    git(&root, &["add", "pending"]);
    let result = monitor(
        &storage,
        &root,
        &request,
        Arc::new(AtomicBool::new(false)),
        |_| {},
        async { git::text(&root, &["commit", "-qm", "blocked"]).map(|_| ()) },
    )
    .await
    .unwrap();
    assert_eq!(result.status, "failed");
    assert!(result.commits.is_empty());
    assert!(result.error.unwrap().contains("hook-blocked"));
    assert_eq!(git(&root, &["diff", "--cached", "--name-only"]), "pending");
}
