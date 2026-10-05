use super::*;
use crate::reviews;

fn fixture() -> (tempfile::TempDir, Storage, Workspace) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("repo");
    fs::create_dir(&root).unwrap();
    for args in [
        vec!["init", "-q"],
        vec!["config", "user.email", "fixture@example.invalid"],
        vec!["config", "user.name", "Fixture"],
        vec!["config", "commit.gpgsign", "false"],
    ] {
        assert!(
            std::process::Command::new("git")
                .args(args)
                .current_dir(&root)
                .output()
                .unwrap()
                .status
                .success()
        );
    }
    fs::write(root.join("a.ts"), "const a = 1;\n").unwrap();
    for args in [vec!["add", "a.ts"], vec!["commit", "-qm", "initial"]] {
        assert!(
            std::process::Command::new("git")
                .args(args)
                .current_dir(&root)
                .output()
                .unwrap()
                .status
                .success()
        );
    }
    fs::write(root.join("a.ts"), "const a = 2;\n").unwrap();
    let storage = Storage::open(dir.path().join("data")).unwrap();
    let repository = repositories::open(&storage, root.to_str().unwrap()).unwrap();
    let workspace = reviews::create(
        &storage,
        CaptureRequest {
            repository_id: repository.id,
            scope: Scope::Local,
            base: None,
            target: None,
            include_untracked: false,
        },
    )
    .unwrap();
    (dir, storage, workspace)
}
fn freeze_workspace(storage: &Storage, workspace: &Workspace) -> FrozenContext {
    freeze(
        storage,
        &workspace.review.repository_id,
        &workspace.review.id,
        &workspace.snapshot.id,
    )
    .unwrap()
}

#[test]
fn freezes_both_briefs_and_withholds_unverified_content_from_writers() {
    let (dir, storage, workspace) = fixture();
    for path in PATHS {
        fs::write(dir.path().join("repo").join(path), format!("Work: {path}")).unwrap();
    }
    let mut frozen = freeze_workspace(&storage, &workspace);
    assert_eq!(frozen.files.len(), 2);
    let identity = frozen.identity().unwrap();
    fs::write(dir.path().join("repo").join(PATHS[1]), "Next pass").unwrap();
    let planning = prompt_context(
        &storage,
        &workspace.review.repository_id,
        &workspace.review.id,
        &workspace.snapshot.id,
        true,
    )
    .unwrap();
    assert_eq!(planning["priority"], PATHS[1]);
    assert!(
        planning["files"][1]["content"]
            .as_str()
            .unwrap()
            .starts_with("Work:")
    );
    let assessments = vec![
        WorkingContextAssessment {
            path: PATHS[0].into(),
            status: WorkingContextStatus::Stale,
            reason: "Wrong scope".into(),
        },
        WorkingContextAssessment {
            path: PATHS[1].into(),
            status: WorkingContextStatus::Accepted,
            reason: "Matches the captured change".into(),
        },
    ];
    assess(&storage, &mut frozen, &assessments).unwrap();
    assert_eq!(frozen.identity().unwrap(), identity);
    let writing = prompt_context(
        &storage,
        &workspace.review.repository_id,
        &workspace.review.id,
        &workspace.snapshot.id,
        false,
    )
    .unwrap();
    assert!(writing["files"][0]["content"].is_null());
    assert!(
        writing["files"][1]["content"]
            .as_str()
            .unwrap()
            .starts_with("Work:")
    );
    let decoded: FrozenContext =
        serde_json::from_slice(&serde_json::to_vec(&frozen).unwrap()).unwrap();
    assert_eq!(decoded.identity().unwrap(), identity);
}

#[test]
fn missing_oversized_and_unreadable_context_does_not_block_review() {
    let (dir, storage, workspace) = fixture();
    assert!(freeze_workspace(&storage, &workspace).files.is_empty());
    fs::write(
        dir.path().join("repo").join(PATHS[0]),
        vec![b'a'; LIMIT as usize + 1],
    )
    .unwrap();
    fs::write(dir.path().join("repo").join(PATHS[1]), [255, 0, 254]).unwrap();
    let context = freeze_workspace(&storage, &workspace);
    assert_eq!(context.files.len(), 2);
    assert!(context.files.iter().all(|file| file.text.is_none()));
    let invalid = context
        .files
        .iter()
        .map(|file| WorkingContextAssessment {
            path: file.summary.path.clone(),
            status: WorkingContextStatus::Accepted,
            reason: "trust it".into(),
        })
        .collect::<Vec<_>>();
    assert!(validate_assessments(&context, &invalid).is_err());
    assert!(validate_assessments(&context, &[]).is_err());
}

#[test]
fn cleanup_requires_completion_and_preserves_newer_or_unused_briefs() {
    let (dir, storage, mut workspace) = fixture();
    for path in PATHS {
        fs::write(dir.path().join("repo").join(path), "original").unwrap();
    }
    let mut context = freeze_workspace(&storage, &workspace);
    for file in &mut context.files {
        file.summary.status = WorkingContextStatus::Accepted;
    }
    persist(&storage, &mut context).unwrap();
    cleanup_using(&storage, &workspace.review, |_| {
        panic!("Draft must not clean context")
    })
    .unwrap();
    fs::write(dir.path().join("repo").join(PATHS[1]), "Next pass").unwrap();
    workspace.review.publication.status = PublicationStatus::CompletedLocal;
    let mut trashed = vec![];
    let result = cleanup_using(&storage, &workspace.review, |path| {
        trashed.push(path.to_path_buf());
        Ok(())
    })
    .unwrap();
    assert_eq!(trashed.len(), 1);
    assert_eq!(result.files[0].cleanup, "trashed");
    assert_eq!(result.files[1].cleanup, "changed");
    assert_eq!(
        fs::read_to_string(dir.path().join("repo").join(PATHS[1])).unwrap(),
        "Next pass"
    );
}

#[test]
fn trash_failure_is_retryable_and_never_permanently_deletes() {
    let (dir, storage, mut workspace) = fixture();
    let path = dir.path().join("repo").join(PATHS[1]);
    fs::write(&path, "original").unwrap();
    let mut context = freeze_workspace(&storage, &workspace);
    context.files[0].summary.status = WorkingContextStatus::Accepted;
    persist(&storage, &mut context).unwrap();
    workspace.review.publication.status = PublicationStatus::CompletedLocal;
    let failed = cleanup_using(&storage, &workspace.review, |_| {
        Err(AppError::new("trash", "Unavailable"))
    })
    .unwrap();
    assert!(failed.files[0].cleanup.starts_with("error:"));
    let recovery = failed.files[0].recovery_path.as_ref().unwrap();
    assert_eq!(
        fs::read_to_string(dir.path().join("repo").join(recovery)).unwrap(),
        "original"
    );
    let retried = cleanup_using(&storage, &workspace.review, |_| Ok(())).unwrap();
    assert_eq!(retried.files[0].cleanup, "trashed");
}

#[cfg(unix)]
#[test]
fn linked_briefs_are_never_read_or_accepted() {
    let (dir, storage, workspace) = fixture();
    let secret = dir.path().join("outside.md");
    fs::write(&secret, "private").unwrap();
    std::os::unix::fs::symlink(&secret, dir.path().join("repo").join(PATHS[1])).unwrap();
    let context = freeze_workspace(&storage, &workspace);
    assert!(context.files[0].text.is_none());
    assert!(context.files[0].summary.hash.is_empty());
}

#[test]
fn a_new_brief_written_during_trash_is_never_removed() {
    let (dir, storage, mut workspace) = fixture();
    let original = dir.path().join("repo").join(PATHS[1]);
    fs::write(&original, "reviewed pass").unwrap();
    let mut context = freeze_workspace(&storage, &workspace);
    context.files[0].summary.status = WorkingContextStatus::Accepted;
    persist(&storage, &mut context).unwrap();
    workspace.review.publication.status = PublicationStatus::CompletedLocal;
    cleanup_using(&storage, &workspace.review, |claimed| {
        fs::write(&original, "new pass").unwrap();
        assert_ne!(claimed, original);
        assert_eq!(fs::read_to_string(claimed).unwrap(), "reviewed pass");
        fs::rename(claimed, dir.path().join("fixture-trash.md"))?;
        Ok(())
    })
    .unwrap();
    assert_eq!(fs::read_to_string(original).unwrap(), "new pass");
}

#[test]
fn crash_after_claim_is_recoverable_and_adaptation_copies_context_to_destination() {
    let (dir, storage, mut workspace) = fixture();
    let root = dir.path().join("repo");
    fs::write(root.join(PATHS[1]), "reviewed pass").unwrap();
    let mut context = freeze_workspace(&storage, &workspace);
    context.files[0].summary.status = WorkingContextStatus::Accepted;
    let receipt = ".reviewbox/.local/context-trash/crash.md";
    context.files[0].summary.recovery_path = Some(receipt.into());
    persist(&storage, &mut context).unwrap();
    fs::create_dir_all(root.join(receipt).parent().unwrap()).unwrap();
    fs::rename(root.join(PATHS[1]), root.join(receipt)).unwrap();
    // Simulate the gap after rename but before the claimed flag persisted.
    workspace.review.publication.status = PublicationStatus::CompletedLocal;
    let result = cleanup_using(&storage, &workspace.review, |path| {
        assert_eq!(path, root.join(receipt).canonicalize().unwrap());
        Ok(())
    })
    .unwrap();
    assert_eq!(result.files[0].cleanup, "trashed");
    transfer(
        &storage,
        &workspace.review.repository_id,
        &workspace.review.id,
        "new-draft",
        &workspace.snapshot.id,
    )
    .unwrap();
    transfer(
        &storage,
        &workspace.review.repository_id,
        &workspace.review.id,
        "new-draft",
        &workspace.snapshot.id,
    )
    .unwrap();
    let copied = load(
        &storage,
        &workspace.review.repository_id,
        "new-draft",
        &workspace.snapshot.id,
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        copied.files[0].summary.status,
        WorkingContextStatus::Accepted
    );
    assert_eq!(copied.files[0].summary.cleanup, "trashed");
}

#[test]
fn a_replaced_claim_is_restored_without_trashing_unreviewed_content() {
    let (dir, storage, mut workspace) = fixture();
    let root = dir.path().join("repo");
    fs::write(root.join(PATHS[1]), "reviewed pass").unwrap();
    let mut context = freeze_workspace(&storage, &workspace);
    context.files[0].summary.status = WorkingContextStatus::Accepted;
    let receipt = ".reviewbox/.local/context-trash/replaced.md";
    context.files[0].summary.recovery_path = Some(receipt.into());
    persist(&storage, &mut context).unwrap();
    fs::create_dir_all(root.join(receipt).parent().unwrap()).unwrap();
    fs::write(root.join(PATHS[1]), "new pass").unwrap();
    fs::rename(root.join(PATHS[1]), root.join(receipt)).unwrap();
    workspace.review.publication.status = PublicationStatus::CompletedLocal;
    let result = cleanup_using(&storage, &workspace.review, |_| {
        panic!("Do not trash changed context")
    })
    .unwrap();
    assert_eq!(result.files[0].cleanup, "changed");
    assert_eq!(fs::read_to_string(root.join(PATHS[1])).unwrap(), "new pass");
}
