use super::*;

fn state() -> PreparationState {
    PreparationState {
        adaptation: None,
        active_batches: vec![],
        phases: vec![],
        id: "operation".into(),
        review_id: "review".into(),
        snapshot_id: "snapshot".into(),
        provider: "claude".into(),
        status: PreparationStatus::Running,
        phase: PreparationPhase::Context,
        completed_batches: 0,
        total_batches: 1,
        steps: vec![],
        events: vec![],
        error: None,
        started_at: now(),
        updated_at: now(),
        can_resume: false,
    }
}
#[test]
fn ready_notifications_exclude_non_success_and_follow_adaptation_destinations() {
    let notices = Arc::new(Mutex::new(Vec::new()));
    let observed = notices.clone();
    let manager = PreparationManager::with_ready_notifier(move |target| {
        observed.lock().unwrap().push(target)
    });
    let mut preparation = state();
    for status in [
        PreparationStatus::Running,
        PreparationStatus::Failed,
        PreparationStatus::Cancelled,
        PreparationStatus::Interrupted,
    ] {
        preparation.status = status;
        manager.notify_ready("checkout", &preparation);
    }
    assert!(notices.lock().unwrap().is_empty());
    preparation.status = PreparationStatus::Ready;
    manager.notify_ready("checkout", &preparation);
    preparation.adaptation = Some(ReviewAdaptation {
        operation_id: "update".into(),
        provider: "claude".into(),
        source_review_id: "review".into(),
        source_revision: 1,
        snapshot_id: "snapshot".into(),
        candidate_review_id: "private-candidate".into(),
        destination_review_id: "published-fork".into(),
        retained_steps: 0,
        rewritten_steps: 1,
        added_steps: 0,
        removed_steps: 0,
    });
    manager.notify_ready("checkout", &preparation);
    let received = notices.lock().unwrap();
    assert_eq!(received.len(), 2);
    assert_eq!(received[0].review_id, "review");
    assert_eq!(received[1].review_id, "published-fork");
    assert_eq!(received[1].repository_id, "checkout");
}

#[test]
fn unavailable_error_log_does_not_replace_a_preparation_failure() {
    tauri::async_runtime::block_on(async {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("not-a-directory");
        std::fs::write(&path, "occupied").unwrap();
        let manager = PreparationManager::default()
            .with_diagnostics(Arc::new(crate::diagnostics::Diagnostics::new(path)));
        let mut error = AppError::new("provider_quota", "Usage limit reached")
            .with_details("Limit reached before the next batch.");
        manager.record_failure("repo", &state(), &mut error).await;
        assert_eq!(error.code, "provider_quota");
        assert!(error.details.unwrap().contains("next batch"));
        assert!(error.diagnostic_id.is_none());
    });
}

#[test]
fn progress_is_bounded_sequenced_and_independent_of_subscribers() {
    let manager = PreparationManager::default();
    manager.active.lock().unwrap().insert(
        "review".into(),
        Active {
            state: state(),
            cancel: Arc::new(AtomicBool::new(false)),
            sequence: 0,
            measurements: vec![],
            finished: Arc::new(AtomicBool::new(false)),
        },
    );
    for index in 0..350 {
        manager.event(
            "review",
            AgentEvent {
                batch_id: None,
                run_id: "provider".into(),
                sequence: 0,
                kind: "progress".into(),
                text: String::new(),
                progress: Some(AgentProgress::Message {
                    id: "same-provider-id".into(),
                    text: index.to_string(),
                }),
            },
            &format!("batch-{index}"),
        );
    }
    let active = manager.active.lock().unwrap();
    let operation = &active["review"];
    assert_eq!(operation.state.events.len(), MAX_EVENTS);
    assert_eq!(operation.state.events.first().unwrap().sequence, 151);
    assert_eq!(operation.state.events.last().unwrap().sequence, 350);
    assert!(
        operation
            .state
            .events
            .iter()
            .all(|event| event.run_id == "operation")
    );
    assert!(!operation.cancel.load(Ordering::Relaxed));
}

#[test]
fn streaming_counters_preserve_meaningful_events_and_ignore_superseded_runs() {
    let manager = PreparationManager::default();
    manager.active.lock().unwrap().insert(
        "review".into(),
        Active {
            state: state(),
            cancel: Arc::new(AtomicBool::new(false)),
            sequence: 0,
            measurements: vec![],
            finished: Arc::new(AtomicBool::new(false)),
        },
    );
    let event = |progress| AgentEvent {
        batch_id: None,
        run_id: "preparation:operation".into(),
        sequence: 0,
        kind: "progress".into(),
        text: String::new(),
        progress: Some(progress),
    };
    manager.event(
        "review",
        event(AgentProgress::Message {
            id: "note".into(),
            text: "A meaningful update".into(),
        }),
        "batch-a",
    );
    for count in 0..500 {
        manager.event(
            "review",
            event(AgentProgress::Draft {
                characters: count,
                topics: vec![],
            }),
            "batch-a",
        );
        manager.event(
            "review",
            event(AgentProgress::Usage {
                id: "thread".into(),
                input: count as u64,
                cached: 0,
                output: 0,
            }),
            "batch-b",
        );
    }
    let mut old = event(AgentProgress::Message {
        id: "old".into(),
        text: "An old run".into(),
    });
    old.run_id = "preparation:previous-operation".into();
    manager.event("review", old, "batch-old");
    let active = manager.active.lock().unwrap();
    let events = &active["review"].state.events;
    assert_eq!(events.len(), 3);
    assert!(matches!(
        events[0].progress,
        Some(AgentProgress::Message { .. })
    ));
    assert!(
        events
            .windows(2)
            .all(|pair| pair[0].sequence < pair[1].sequence)
    );
    assert_eq!(events[2].sequence, 1001);
}
#[test]
fn checkpoint_resume_requires_identical_sources_prompts_and_provider() {
    let checkpoint = Checkpoint {
        working_context: None,
        revision: 0,
        review_revision: 0,
        repository_id: "repo".into(),
        state: state(),
        source_hash: "source".into(),
        prompt_hash: "prompt".into(),
        provider_hash: "provider".into(),
        helper_model: None,
        definitions: BTreeMap::new(),
        results: BTreeMap::new(),
        measurements: vec![],
    };
    compatible(&checkpoint, "source", "prompt", "provider").unwrap();
    for (source, prompt, provider) in [
        ("changed", "prompt", "provider"),
        ("source", "changed", "provider"),
        ("source", "prompt", "changed"),
    ] {
        assert_eq!(
            compatible(&checkpoint, source, prompt, provider)
                .unwrap_err()
                .code,
            "preparation_changed"
        );
    }
}

#[test]
fn restart_marks_checkpoints_interrupted_without_starting_provider_work() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("private");
    let storage = Storage::open(root.clone()).unwrap();
    let checkpoint = Checkpoint {
        working_context: None,
        revision: 0,
        review_revision: 0,
        repository_id: "repo".into(),
        state: state(),
        source_hash: "source".into(),
        prompt_hash: "prompt".into(),
        provider_hash: "provider".into(),
        helper_model: None,
        definitions: BTreeMap::new(),
        results: BTreeMap::from([("outline".into(), json!({"topics":[]}))]),
        measurements: vec![],
    };
    storage
        .insert(KIND, &checkpoint.key(), &checkpoint)
        .unwrap();
    drop(storage);
    let reopened = Storage::open(root).unwrap();
    let manager = PreparationManager::default();
    let state = reopened
        .get::<Checkpoint>(KIND, &checkpoint.key())
        .unwrap()
        .state;
    assert_eq!(state.status, PreparationStatus::Interrupted);
    assert!(manager.active.lock().unwrap().is_empty());
    let persisted: Checkpoint = reopened.get(KIND, &checkpoint.key()).unwrap();
    assert_eq!(persisted.revision, 1);
    assert!(persisted.results.contains_key("outline"));
}

#[cfg(unix)]
pub(super) mod native {
    use super::*;
    use std::{fs, path::Path, process::Command};

    fn git(root: &Path, args: &[&str]) {
        let result = Command::new("git")
            .current_dir(root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
    pub(in crate::preparation) fn fixture() -> (tempfile::TempDir, Storage, Workspace) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("repo");
        fs::create_dir(&root).unwrap();
        git(&root, &["init", "-q"]);
        git(&root, &["config", "user.name", "ReviewBox"]);
        git(&root, &["config", "user.email", "test@example.invalid"]);
        fs::write(root.join("code.ts"), "const amount = 1;\n").unwrap();
        git(&root, &["add", "."]);
        git(
            &root,
            &["-c", "commit.gpgsign=false", "commit", "-qm", "initial"],
        );
        fs::write(root.join("code.ts"), "const amount = 2;\n").unwrap();
        let storage = Storage::open(dir.path().join("local")).unwrap();
        let repository = crate::repositories::open(&storage, root.to_str().unwrap()).unwrap();
        let workspace = reviews::create(
            &storage,
            CaptureRequest {
                repository_id: repository.id,
                scope: Scope::Local,
                base: None,
                target: None,
                include_untracked: true,
            },
        )
        .unwrap();
        (dir, storage, workspace)
    }
}
