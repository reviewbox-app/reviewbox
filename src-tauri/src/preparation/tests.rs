use super::*;

fn state() -> PreparationState {
    PreparationState {
        translation_selection: None,
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
        step_titles: vec![],
        events: vec![],
        error: None,
        started_at: now(),
        updated_at: now(),
        can_resume: false,
    }
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
fn source_segments_preserve_crlf_unicode_and_final_line_with_strict_bounds() {
    let text = format!("{}last", "é\r\n".repeat(405));
    let parts = segments(&text).unwrap();
    assert_eq!(
        parts
            .iter()
            .map(|part| part.text.as_str())
            .collect::<String>(),
        text
    );
    assert_eq!(parts.len(), 1);
    assert_eq!((parts[0].start_line, parts[0].end_line), (1, 406));
    assert_eq!(segments(&"a".repeat(100_000)).unwrap().len(), 1);
    assert!(segments("").unwrap().is_empty());
    assert_eq!(segments("a\n").unwrap()[0].end_line, 1);
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
fn translations_reject_missing_overlapping_or_reordered_lines() {
    let segment = Segment {
        start_line: 5,
        end_line: 8,
        text: "a\nb\nc\nd".into(),
    };
    for ranges in [vec![(5, 6), (6, 8)], vec![(7, 8), (5, 6)], vec![(5, 9)]] {
        let result = TranslationResult {
            blocks: ranges
                .into_iter()
                .map(|(start_line, end_line)| PseudoBlock {
                    start_line,
                    end_line,
                    text: "Read a value".into(),
                })
                .collect(),
        };
        assert!(validate_translation(&result, &segment).is_err());
    }
    let result = TranslationResult {
        blocks: vec![PseudoBlock {
            start_line: 5,
            end_line: 8,
            text: "Read the four values".into(),
        }],
    };
    validate_translation(&result, &segment).unwrap();
}
#[test]
fn checkpoint_resume_requires_identical_sources_prompts_and_provider() {
    let checkpoint = Checkpoint {
        revision: 0,
        review_revision: 0,
        repository_id: "repo".into(),
        state: state(),
        source_hash: "source".into(),
        prompt_hash: "prompt".into(),
        provider_hash: "provider".into(),
        helper_model: None,
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
        revision: 0,
        review_revision: 0,
        repository_id: "repo".into(),
        state: state(),
        source_hash: "source".into(),
        prompt_hash: "prompt".into(),
        provider_hash: "provider".into(),
        helper_model: None,
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
    use std::{
        fs,
        os::unix::fs::PermissionsExt,
        process::Command,
        time::{Duration, Instant},
    };

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
        let executable = dir.path().join("claude");
        fs::write(&executable, r#"#!/usr/bin/env python3
import sys,json,pathlib,time
base=pathlib.Path(sys.argv[0]).parent
if '--input-format' in sys.argv:
    request=json.loads(sys.stdin.readline())
    print(json.dumps({'type':'control_response','response':{'request_id':request['request_id'],'subtype':'success','response':{'models':[{'value':'claude-sonnet-5','displayName':'Sonnet 5','supportsEffort':True,'supportedEffortLevels':['medium','high']}]}}}),flush=True);sys.exit(0)
prompt=sys.stdin.read()
context=json.loads(prompt.split('Context:\n',1)[1].split('\n\nBatch input:',1)[0])
value=json.loads(prompt.split('Batch input:\n',1)[1].split('\n\nContract:',1)[0])
batch=value;results=[]
for item in batch['items']:
 value=item['input']
 kind='pseudo' if 'segment' in value else value.get('scope','outline')
 with (base/'calls').open('a') as output: output.write(kind+'\n')
 if kind=='readingStep' and (base/'pause').exists():
     while (base/'pause').exists(): time.sleep(.03)
 if kind=='outline':
     manifest=json.loads(pathlib.Path(context['reviewManifest']).read_text())
     change=json.loads(pathlib.Path(manifest['changes'][0]['metadata']).read_text())
     result={'translationFiles':[f['id'] for f in value['files'] if not (base/'skip-all').exists()],'topics':[{'title':'Adjust the amount','brief':'The amount is updated.','steps':[{'title':'Understand the new amount','anchors':[change['anchors'][0]]}]}]}
 elif kind=='pseudo':
     segment=value['segment']; result={'blocks':[{'startLine':segment['startLine'],'endLine':segment['endLine'],'text':'Remember the requested amount'}]}
     if (base/'invalid-pseudo').exists(): result={'blocks':[{'startLine':0,'endLine':1,'text':'Invalid range'}]}
 else:
     result={level:{'body':body,'readingSeconds':30,'references':[],'terms':[]} for level,body in [('beginner','The remembered amount changes.'),('intermediate','The stored amount is updated to the requested value.'),('developer','The assignment now uses the new amount while preserving its structure.')]}
     if (base/'invalid').exists(): result={'bad':'shape'}
 results.append({'id':item['id'],'result':result})
result={'items':results}
print(json.dumps({'type':'result','is_error':False,'result':json.dumps(result)}),flush=True)
"#).unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let mut settings = agents::settings(&storage).unwrap();
        let config = settings
            .providers
            .iter_mut()
            .find(|provider| provider.provider == "claude")
            .unwrap();
        config.executable = executable.to_string_lossy().into_owned();
        config.model = None;
        agents::configure(&storage, settings).unwrap();
        (dir, storage, workspace)
    }
    pub(in crate::preparation) fn resources() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/agents")
    }

    #[test]
    fn preparation_state_and_cancellation_are_isolated_between_copied_checkouts() {
        let (dir, storage, workspace) = fixture();
        let repository: Repository = storage
            .get("repository", &workspace.review.repository_id)
            .unwrap();
        let copied_path = dir.path().join("copied-repository");
        assert!(
            Command::new("cp")
                .arg("-R")
                .arg(&repository.path)
                .arg(&copied_path)
                .status()
                .unwrap()
                .success()
        );
        let copied = crate::repositories::open(&storage, copied_path.to_str().unwrap()).unwrap();
        let original_storage = storage.scoped(Some(&repository.id));
        let copied_storage = storage.scoped(Some(&copied.id));
        assert_eq!(
            reviews::load(&copied_storage, &workspace.review.id)
                .unwrap()
                .review
                .id,
            workspace.review.id
        );
        let mut state = state();
        state.review_id = workspace.review.id.clone();
        state.snapshot_id = workspace.snapshot.id.clone();
        let checkpoint = Checkpoint {
            revision: 0,
            review_revision: workspace.review.revision,
            repository_id: repository.id,
            state: state.clone(),
            source_hash: String::new(),
            prompt_hash: String::new(),
            provider_hash: String::new(),
            helper_model: None,
            results: BTreeMap::new(),
            measurements: vec![],
        };
        storage
            .insert(KIND, &checkpoint.key(), &checkpoint)
            .unwrap();
        let manager = PreparationManager::default();
        let cancel = Arc::new(AtomicBool::new(false));
        manager.active.lock().unwrap().insert(
            checkpoint.key(),
            Active {
                state,
                cancel: cancel.clone(),
                sequence: 0,
                measurements: vec![],
            },
        );
        assert!(
            manager
                .get(&original_storage, &workspace.review.id, None)
                .unwrap()
                .is_some()
        );
        assert!(
            manager
                .get(&copied_storage, &workspace.review.id, None)
                .unwrap()
                .is_none()
        );
        manager
            .cancel(&copied_storage, &workspace.review.id)
            .unwrap();
        assert!(!cancel.load(Ordering::Relaxed));
        manager
            .cancel(&original_storage, &workspace.review.id)
            .unwrap();
        assert!(cancel.load(Ordering::Relaxed));
    }

    #[test]
    fn an_old_ready_checkpoint_cannot_resume_or_mask_a_refreshed_capture() {
        let (_dir, storage, workspace) = fixture();
        let mut state = state();
        state.review_id = workspace.review.id.clone();
        state.snapshot_id = workspace.snapshot.id.clone();
        state.status = PreparationStatus::Ready;
        let checkpoint = Checkpoint {
            revision: 0,
            review_revision: workspace.review.revision,
            repository_id: workspace.review.repository_id.clone(),
            state,
            source_hash: String::new(),
            prompt_hash: String::new(),
            provider_hash: String::new(),
            helper_model: None,
            results: BTreeMap::new(),
            measurements: vec![],
        };
        storage
            .insert(KIND, &checkpoint.key(), &checkpoint)
            .unwrap();
        let refreshed =
            reviews::refresh(&storage, &workspace.review.id, workspace.review.revision).unwrap();
        assert_ne!(refreshed.snapshot.id, workspace.snapshot.id);
        let manager = PreparationManager::default();
        assert!(
            manager
                .get(&storage, &workspace.review.id, None)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            manager
                .resume(storage, resources(), &workspace.review.id)
                .unwrap_err()
                .code,
            "preparation_changed"
        );
    }
    async fn until(
        manager: &PreparationManager,
        storage: &Storage,
        review: &str,
        condition: impl Fn(&PreparationState) -> bool,
    ) -> PreparationState {
        let start = Instant::now();
        loop {
            let state = manager.get(storage, review, None).unwrap().unwrap();
            if condition(&state) {
                return state;
            }
            assert!(
                start.elapsed() < Duration::from_secs(30),
                "timeout: {:?}",
                state
            );
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    }
    #[test]
    fn preparation_detaches_resumes_completed_batches_and_publishes_once() {
        tauri::async_runtime::block_on(async {
            let (dir, storage, workspace) = fixture();
            fs::write(dir.path().join("pause"), "").unwrap();
            let manager = PreparationManager::default();
            let started = manager
                .start(
                    storage.clone(),
                    resources(),
                    PreparationRequest {
                        review_id: workspace.review.id.clone(),
                        provider: "claude".into(),
                    },
                )
                .unwrap();
            assert_eq!(started.status, PreparationStatus::Running);
            until(&manager, &storage, &workspace.review.id, |state| {
                state.completed_batches >= 1
            })
            .await;
            // No subscriber exists; the native operation remains alive.
            assert_eq!(
                manager
                    .get(&storage, &workspace.review.id, Some(u32::MAX))
                    .unwrap()
                    .unwrap()
                    .events
                    .len(),
                0
            );
            manager.cancel(&storage, &workspace.review.id).unwrap();
            let cancelled = until(&manager, &storage, &workspace.review.id, |state| {
                state.status != PreparationStatus::Running
            })
            .await;
            assert_eq!(cancelled.status, PreparationStatus::Cancelled);
            assert!(cancelled.completed_batches >= 1);
            fs::remove_file(dir.path().join("pause")).unwrap();
            manager
                .resume(storage.clone(), resources(), &workspace.review.id)
                .unwrap();
            let ready = until(&manager, &storage, &workspace.review.id, |state| {
                state.status != PreparationStatus::Running
            })
            .await;
            assert_eq!(ready.status, PreparationStatus::Ready, "{:?}", ready.error);
            assert_eq!(ready.id, started.id);
            let review = reviews::load(&storage, &workspace.review.id)
                .unwrap()
                .review;
            assert_eq!(review.topics.len(), 1);
            assert_eq!(review.topics[0].steps.len(), 1);
            assert_eq!(review.files.len(), 1);
            let calls = fs::read_to_string(dir.path().join("calls")).unwrap();
            assert_eq!(calls.lines().filter(|line| *line == "outline").count(), 1);
            manager
                .resume(storage.clone(), resources(), &workspace.review.id)
                .unwrap();
            assert_eq!(fs::read_to_string(dir.path().join("calls")).unwrap(), calls);
            assert_eq!(
                reviews::load(&storage, &workspace.review.id)
                    .unwrap()
                    .review
                    .revision,
                review.revision
            );
        });
    }
    #[test]
    fn invalid_batch_is_corrected_three_times_then_keeps_the_checkpoint() {
        tauri::async_runtime::block_on(async {
            let (dir, storage, workspace) = fixture();
            fs::write(dir.path().join("invalid"), "").unwrap();
            let manager = PreparationManager::default();
            manager
                .start(
                    storage.clone(),
                    resources(),
                    PreparationRequest {
                        review_id: workspace.review.id.clone(),
                        provider: "claude".into(),
                    },
                )
                .unwrap();
            let failed = until(&manager, &storage, &workspace.review.id, |state| {
                state.status != PreparationStatus::Running
            })
            .await;
            assert_eq!(failed.status, PreparationStatus::Failed);
            assert!(failed.can_resume);
            assert!(failed.completed_batches >= 1);
            assert_eq!(
                fs::read_to_string(dir.path().join("calls"))
                    .unwrap()
                    .lines()
                    .filter(|line| *line == "readingStep")
                    .count(),
                4
            );
            assert!(
                reviews::load(&storage, &workspace.review.id)
                    .unwrap()
                    .review
                    .topics
                    .is_empty()
            );
        });
    }

    #[test]
    fn invalid_pseudocode_does_not_block_the_verified_documents_or_publish_partial_blocks() {
        tauri::async_runtime::block_on(async {
            let (dir, storage, workspace) = fixture();
            fs::write(dir.path().join("invalid-pseudo"), "").unwrap();
            let manager = PreparationManager::default();
            manager
                .start(
                    storage.clone(),
                    resources(),
                    PreparationRequest {
                        review_id: workspace.review.id.clone(),
                        provider: "claude".into(),
                    },
                )
                .unwrap();
            let ready = until(&manager, &storage, &workspace.review.id, |state| {
                state.status != PreparationStatus::Running
            })
            .await;
            assert_eq!(ready.status, PreparationStatus::Ready, "{:?}", ready.error);
            let review = reviews::load(&storage, &workspace.review.id)
                .unwrap()
                .review;
            assert_eq!(review.topics[0].steps.len(), 1);
            let file = reader::read_file(&storage, &review.id, &review.files[0].id).unwrap();
            assert!(file.documents.is_none());
            assert!(
                file.translations
                    .iter()
                    .all(|translation| translation.blocks.is_empty()
                        && translation.unavailable_reason.is_some())
            );
            let calls = fs::read_to_string(dir.path().join("calls")).unwrap();
            assert_eq!(
                calls.lines().filter(|kind| *kind == "pseudo").count(),
                8,
                "each frozen side gets an initial attempt and three repairs"
            );
        });
    }
}
