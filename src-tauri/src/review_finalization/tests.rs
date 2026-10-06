use super::*;
use std::{fs, path::Path, process::Command};
fn git(root: &Path, args: &[&str]) {
    let out = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}
fn fixture(local: bool) -> (tempfile::TempDir, Storage, Workspace) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("repo");
    fs::create_dir(&root).unwrap();
    git(&root, &["init", "-q"]);
    git(&root, &["config", "user.name", "Test"]);
    git(&root, &["config", "user.email", "test@example.invalid"]);
    fs::write(root.join("a.ts"), "const a = 1;\n").unwrap();
    git(&root, &["add", "."]);
    git(&root, &["commit", "-qm", "base"]);
    let storage = Storage::open(dir.path().join("app")).unwrap();
    let repo = crate::repositories::open(&storage, root.to_str().unwrap()).unwrap();
    let storage = storage.for_finalization(&repo.id);
    fs::write(root.join("a.ts"), "const a = 2;\n").unwrap();
    let mut w = reviews::create(
        &storage,
        CaptureRequest {
            repository_id: repo.id,
            scope: Scope::Local,
            base: None,
            target: None,
            include_untracked: true,
        },
    )
    .unwrap();
    if local {
        w = reviews::apply(
            &storage,
            &w.review.id,
            w.review.revision,
            ReviewAction::SetKeepLocal { keep_local: true },
        )
        .unwrap();
    }
    (dir, storage, w)
}
#[test]
fn completion_is_durable_before_publication_failure_and_retry_is_idempotent() {
    let (_dir, storage, w) = fixture(false);
    let mut saw_saved = false;
    let result = run(
        &storage,
        &w.review.id,
        w.review.revision,
        ReviewAction::CompleteManualReview,
        &mut |step, status, _| {
            if step == "save" && status == FinalizationStepStatus::Completed {
                saw_saved = true;
                assert!(
                    reviews::load(&storage, &w.review.id)?
                        .review
                        .publication
                        .is_complete()
                );
            }
            if step == "verify" && status == FinalizationStepStatus::Running {
                return Err(AppError::new(
                    "test_failure",
                    "Verification fixture failure",
                ));
            }
            Ok(())
        },
        &|| {},
    );
    assert!(saw_saved);
    assert!(result.is_err());
    let pending = reviews::load(&storage, &w.review.id).unwrap();
    assert_eq!(
        pending.review.publication.status,
        PublicationStatus::PublicationPending
    );
    let completion = pending.review.publication.completion.clone();
    run(
        &storage,
        &w.review.id,
        w.review.revision,
        ReviewAction::CompleteManualReview,
        &mut |_, _, _| Ok(()),
        &|| {},
    )
    .unwrap();
    let published = reviews::load(&storage, &w.review.id).unwrap();
    assert_eq!(
        published.review.publication.status,
        PublicationStatus::Published
    );
    assert_eq!(published.review.publication.completion, completion);
    run(
        &storage,
        &w.review.id,
        w.review.revision,
        ReviewAction::CompleteManualReview,
        &mut |_, _, _| Ok(()),
        &|| {},
    )
    .unwrap();
    assert_eq!(
        reviews::load(&storage, &w.review.id)
            .unwrap()
            .review
            .revision,
        published.review.revision
    );
}
#[test]
fn local_completion_skips_shared_publication_and_preserves_source_and_index() {
    let (_dir, storage, w) = fixture(true);
    let repo: Repository = storage.get("repository", &w.review.repository_id).unwrap();
    let root = Path::new(&repo.path);
    let index = fs::read(root.join(".git/index")).unwrap();
    let mut skipped = vec![];
    run(
        &storage,
        &w.review.id,
        w.review.revision,
        ReviewAction::CompleteManualReview,
        &mut |step, status, _| {
            if status == FinalizationStepStatus::Skipped {
                skipped.push(step.to_string());
            }
            Ok(())
        },
        &|| {},
    )
    .unwrap();
    assert_eq!(
        skipped,
        ["preserve", "commits", "archive", "verify", "publish"]
    );
    assert_eq!(
        reviews::load(&storage, &w.review.id)
            .unwrap()
            .review
            .publication
            .status,
        PublicationStatus::CompletedLocal
    );
    assert_eq!(fs::read(root.join(".git/index")).unwrap(), index);
    assert_eq!(
        fs::read_to_string(root.join("a.ts")).unwrap(),
        "const a = 2;\n"
    );
}
#[test]
fn persisted_running_job_becomes_interrupted_and_sequence_remains_monotone() {
    let (_dir, storage, w) = fixture(true);
    let mut state = initial(
        w.review.repository_id.clone(),
        w.review.id.clone(),
        ReviewAction::CompleteManualReview,
        8,
    );
    transition(&mut state, "save", FinalizationStepStatus::Running, None);
    storage.save_finalization(&state).unwrap();
    let recovered = Finalizations::default()
        .read(&storage, &w.review.repository_id, &w.review.id)
        .unwrap()
        .unwrap();
    assert_eq!(recovered.status, FinalizationStatus::Interrupted);
    assert!(recovered.sequence > state.sequence);
    assert!(recovered.steps[0].started_at.is_some());
}
#[test]
fn changed_project_during_publication_is_not_overwritten() {
    let (_dir, storage, w) = fixture(false);
    let result = run(
        &storage,
        &w.review.id,
        w.review.revision,
        ReviewAction::CompleteManualReview,
        &mut |step, status, _| {
            if step == "verify" && status == FinalizationStepStatus::Completed {
                let mut settings = storage.project_settings(&w.review.repository_id)?;
                settings.language = "English".into();
                storage.save_project_settings(&w.review.repository_id, settings)?;
            }
            Ok(())
        },
        &|| {},
    );
    assert!(result.is_err());
    let current = reviews::load(&storage, &w.review.id).unwrap();
    assert_eq!(
        storage
            .project_settings(&w.review.repository_id)
            .unwrap()
            .language,
        "English"
    );
    assert_eq!(
        current.review.publication.status,
        PublicationStatus::PublicationPending
    );
}

#[test]
fn live_job_reconciliation_never_marks_it_interrupted() {
    let (_dir, storage, w) = fixture(true);
    let manager = Finalizations::default();
    let state = initial(
        w.review.repository_id.clone(),
        w.review.id.clone(),
        ReviewAction::CompleteManualReview,
        0,
    );
    manager.publish(&storage, &state, &|_| {}).unwrap();
    let restored = manager
        .read(&storage, &w.review.repository_id, &w.review.id)
        .unwrap()
        .unwrap();
    assert_eq!(restored.id, state.id);
    assert_eq!(restored.status, FinalizationStatus::Running);
}
