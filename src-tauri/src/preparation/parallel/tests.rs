use super::*;
use std::{collections::BTreeSet, fs, os::unix::fs::PermissionsExt, time::Instant};

fn fixture() -> (tempfile::TempDir, Storage, Workspace) {
    let (dir, storage, workspace) = crate::preparation::tests::native::fixture();
    let executable = dir.path().join("parallel-codex");
    fs::write(&executable, r#"#!/usr/bin/env python3
import sys,json,pathlib,time,os
base=pathlib.Path(sys.argv[0]).parent
args=sys.argv[1:]
if args==['--version']: print('codex-cli 0.157.1');sys.exit(0)
if 'generate-json-schema' in args:
 out=pathlib.Path(args[args.index('--out')+1])/'v2';out.mkdir(parents=True,exist_ok=True)
 (out/'ThreadStartParams.json').write_text(json.dumps({'properties':{'ephemeral':{'type':'boolean'}},'definitions':{'SandboxMode':{'enum':['danger-full-access']}}}));sys.exit(0)
def send(value): print(json.dumps(value),flush=True)
def record(kind,**data):
 with (base/'parallel-calls').open('a') as f:f.write(json.dumps(dict(event=kind,pid=os.getpid(),time=time.time(),**data))+'\n')
record('process')
thread='';turn='';model=None
for line in sys.stdin:
 value=json.loads(line);method=value.get('method');rpc=value.get('id')
 if method=='initialize':send({'id':rpc,'result':{}})
 if method=='model/list':
  models=[{'model':'gpt-6-sol','displayName':'Sol','supportedReasoningEfforts':[{'reasoningEffort':'medium'}]}]
  if not (base/'missing-helper').exists():models.append({'model':'gpt-6-luna','displayName':'Luna','supportedReasoningEfforts':[{'reasoningEffort':'high'}]})
  send({'id':rpc,'result':{'data':models,'nextCursor':None}})
 if method=='thread/start':
  model=value['params'].get('model');thread='thread-'+str(rpc);send({'id':rpc,'result':{'thread':{'id':thread,'ephemeral':True}}})
 if method=='thread/read':
  assert value['params']['includeTurns'] is False
  send({'id':rpc,'result':{'thread':{'id':value['params']['threadId'],'model':'gpt-6-luna'}}})
 if method=='thread/unsubscribe':send({'id':rpc,'result':{'status':'notSubscribed' if (base/'cleanup-fails').exists() else 'unsubscribed'}})
 if method!='turn/start':continue
 turn='turn-'+str(rpc);send({'id':rpc,'result':{'turn':{'id':turn}}})
 params=value['params'];assert 'outputSchema' in params
 def check_schema(schema):
  if isinstance(schema,dict):
   if schema.get('type')=='object' and 'properties' in schema:assert schema.get('additionalProperties') is False and set(schema.get('required',[]))==set(schema['properties'])
   for child in schema.values():check_schema(child)
  elif isinstance(schema,list):
   for child in schema:check_schema(child)
 check_schema(params['outputSchema'])
 assert 'agents.enabled=true' in args and 'agents.max_concurrent_threads_per_session=3' in args
 prompt=params['input'][0]['text']
 context=json.loads(prompt.split('Context:\n',1)[1].split('\n\nBatch input:',1)[0])
 batch=json.loads(prompt.split('Batch input:\n',1)[1].split('\n\nContract:',1)[0])
 record('start',model=model,items=[i['id'] for i in batch['items']]);time.sleep(.15)
 # An interleaved child's final JSON and completion must never finish this root.
 send({'method':'item/started','params':{'threadId':thread,'turnId':turn,'item':{'type':'collabAgentToolCall','id':'spawn','receiverThreadIds':['child'],'agentsStates':{'child':{'status':'running'}},'model':'gpt-6-luna'}}})
 send({'method':'item/completed','params':{'threadId':'child','turnId':'child-turn','item':{'type':'agentMessage','id':'final','phase':'final_answer','text':'{"WRONG":"child"}'}}})
 send({'method':'turn/completed','params':{'threadId':'child','turn':{'id':'child-turn','status':'completed'}}})
 send({'method':'item/completed','params':{'threadId':thread,'turnId':'old-turn','item':{'type':'agentMessage','id':'stale','phase':'final_answer','text':'{"WRONG":"old"}'}}})
 send({'method':'item/completed','params':{'threadId':thread,'turnId':turn,'item':{'type':'collabAgentToolCall','id':'wait','receiverThreadIds':['child'],'agentsStates':{'child':{'status':'completed'}}}}})
 send({'method':'item/completed','params':{'threadId':thread,'turnId':turn,'item':{'type':'subAgentActivity','id':'modern-spawn','agentThreadId':'new-child','agentPath':'/root/write_document','kind':'started'}}})
 metadata=json.loads(sys.stdin.readline());assert metadata['method']=='thread/read' and metadata['params']['includeTurns'] is False
 send({'id':metadata['id'],'result':{'thread':{'id':'new-child','model':'gpt-6-luna'}}})
 send({'method':'turn/completed','params':{'threadId':'new-child','turn':{'id':'child-turn','status':'completed'}}})
 send({'method':'item/completed','params':{'threadId':thread,'turnId':turn,'item':{'type':'subAgentActivity','id':'modern-end','agentThreadId':'new-child','agentPath':'/root/write_document','kind':'completed'}}})
 results=[]
 for item in batch['items']:
  key=item['id'];data=item['input']
  if key=='outline':
   manifest=json.loads(pathlib.Path(context['reviewManifest']).read_text());change=json.loads(pathlib.Path(manifest['changes'][0]['metadata']).read_text())
   choices=[f['id'] for f in data['files'] if not (base/'skip-all').exists() and f['path'] not in (json.loads((base/'skip-paths').read_text()) if (base/'skip-paths').exists() else [])]
   result={'translationFiles':choices,'topics':[{'title':'Amount','brief':'The amount changes.','steps':[{'title':'Explain amount '+str(i),'anchors':[change['anchors'][0]]} for i in range(4)]}]}
  elif key.startswith('pseudo:'):
   segment=data['segment'];result={'blocks':[{'startLine':segment['startLine'],'endLine':segment['endLine'],'text':'Remember the captured amount.'}]}
  else:
   result={level:{'body':body,'readingSeconds':30,'references':[],'terms':[]}for level,body in [('beginner','The remembered amount changes.'),('intermediate','The stored amount now reflects the requested value.'),('developer','The assignment changes its value while retaining its public role.')]}
   if (base/'repair').exists() and key=='step:0:1':
    flag=base/'repaired'
    if not flag.exists():flag.write_text('1');result={'invalid':True}
  results.append({'id':key,'result':result})
 if (base/'pause').exists() and any(i['id'].startswith('step:') for i in batch['items']):
  while (base/'pause').exists():time.sleep(.03)
 if (base/'pause-translations').exists() and any(i['id'].startswith('pseudo:') for i in batch['items']):
  while (base/'pause-translations').exists():time.sleep(.03)
 payload={'items':results}
 if (base/'oversize').exists() and len(results)>1:payload['padding']='x'*600000
 if (base/'rate-limit').exists():
  send({'method':'turn/completed','params':{'threadId':thread,'turn':{'id':turn,'status':'failed','error':{'codexErrorInfo':'rateLimitExceeded','message':'capacity'}}}});record('end');continue
 send({'method':'item/completed','params':{'threadId':thread,'turnId':turn,'item':{'type':'agentMessage','id':'final','phase':'final_answer','text':json.dumps(payload)}}})
 send({'method':'turn/completed','params':{'threadId':thread,'turn':{'id':turn,'status':'completed'}}})
 record('end')
"#).unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let mut settings = agents::settings(&storage).unwrap();
    settings
        .providers
        .iter_mut()
        .find(|p| p.provider == "codex")
        .unwrap()
        .executable = executable.to_string_lossy().into();
    agents::configure(&storage, settings).unwrap();
    (dir, storage, workspace)
}
fn wait(
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
        assert!(start.elapsed() < Duration::from_secs(20), "{:?}", state);
        std::thread::sleep(Duration::from_millis(20));
    }
}
fn start(manager: &PreparationManager, storage: &Storage, workspace: &Workspace) {
    manager
        .start(
            storage.clone(),
            crate::preparation::tests::native::resources(),
            PreparationRequest {
                review_id: workspace.review.id.clone(),
                provider: "codex".into(),
            },
        )
        .unwrap();
}
fn calls(dir: &Path) -> Vec<Value> {
    fs::read_to_string(dir.join("parallel-calls"))
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}
#[test]
fn schedules_parallel_batches_isolates_children_and_repairs_only_invalid_items() {
    let (dir, storage, workspace) = fixture();
    fs::write(dir.path().join("repair"), "").unwrap();
    let manager = PreparationManager::default();
    start(&manager, &storage, &workspace);
    let state = wait(&manager, &storage, &workspace.review.id, |s| {
        s.status != PreparationStatus::Running
    });
    assert_eq!(state.status, PreparationStatus::Ready, "{:?}", state.error);
    assert_eq!(state.step_titles.len(), 4);
    assert_eq!(state.completed_batches, state.total_batches);
    assert!(state.events.iter().any(|event| matches!(&event.progress, Some(AgentProgress::Delegation { model: Some(model), .. }) if model == "gpt-6-luna")));
    assert!(state.events.iter().any(|event| matches!(&event.progress, Some(AgentProgress::Delegation { id, model: Some(model), .. }) if id.ends_with("new-child") && model == "gpt-6-luna")));
    let calls = calls(dir.path());
    for event in calls.iter().filter(|event| event["event"] == "start") {
        let items = event["items"].as_array().unwrap();
        assert!(
            items
                .iter()
                .all(|item| !item.as_str().unwrap().starts_with("file:")),
            "File explanations must never be scheduled"
        );
        let translation = items[0].as_str().unwrap().starts_with("pseudo:");
        assert_eq!(
            event["model"],
            if translation {
                "gpt-6-luna"
            } else {
                "gpt-6-sol"
            }
        );
    }
    let mut active = 0;
    let mut maximum = 0;
    let mut counts = BTreeMap::new();
    let mut processes = BTreeSet::new();
    for event in calls {
        match event["event"].as_str() {
            Some("start") => {
                active += 1;
                maximum = maximum.max(active);
                processes.insert(event["pid"].as_u64().unwrap());
                for item in event["items"].as_array().unwrap() {
                    *counts.entry(item.as_str().unwrap().to_owned()).or_insert(0) += 1;
                }
            }
            Some("end") => active -= 1,
            _ => {}
        }
    }
    assert_eq!(maximum, 3);
    assert!(processes.len() <= 4);
    assert_eq!(counts["step:0:0"], 1);
    assert_eq!(counts["step:0:1"], 2);
    assert_eq!(counts["outline"], 1);
    let review = reviews::load(&storage, &workspace.review.id).unwrap();
    assert_eq!(
        review
            .review
            .topics
            .iter()
            .map(|t| t.steps.len())
            .sum::<usize>(),
        4
    );
}
#[test]
fn cancellation_keeps_results_and_resume_does_not_repeat_completed_batches() {
    let (dir, storage, workspace) = fixture();
    fs::write(dir.path().join("pause"), "").unwrap();
    let manager = PreparationManager::default();
    start(&manager, &storage, &workspace);
    wait(&manager, &storage, &workspace.review.id, |s| {
        s.active_batches
            .iter()
            .any(|b| b.phase == PreparationPhase::Documents)
    });
    manager.cancel(&storage, &workspace.review.id).unwrap();
    let stopped = wait(&manager, &storage, &workspace.review.id, |s| {
        s.status != PreparationStatus::Running
    });
    assert_eq!(stopped.status, PreparationStatus::Cancelled);
    assert!(stopped.can_resume);
    fs::remove_file(dir.path().join("pause")).unwrap();
    manager
        .resume(
            storage.clone(),
            crate::preparation::tests::native::resources(),
            &workspace.review.id,
        )
        .unwrap();
    let ready = wait(&manager, &storage, &workspace.review.id, |s| {
        s.status != PreparationStatus::Running
    });
    assert_eq!(ready.status, PreparationStatus::Ready, "{:?}", ready.error);
    assert_eq!(
        calls(dir.path())
            .iter()
            .filter(|e| e["event"] == "start"
                && e["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|i| i == "outline"))
            .count(),
        1
    );
}
#[test]
fn two_preparations_share_category_and_global_limits() {
    let (_a, first, wa) = fixture();
    let (_b, second, wb) = fixture();
    let manager = PreparationManager::default();
    start(&manager, &first, &wa);
    start(&manager, &second, &wb);
    let start = Instant::now();
    let mut max = 0;
    loop {
        let a = manager.get(&first, &wa.review.id, None).unwrap().unwrap();
        let b = manager.get(&second, &wb.review.id, None).unwrap().unwrap();
        // Observe one instant: two independent UI reads can straddle a handoff
        // and count the same global permit in both preparations.
        let count: usize = manager
            .active
            .lock()
            .unwrap()
            .values()
            .map(|active| active.state.active_batches.len())
            .sum();
        assert!(count <= MAX_COORDINATORS);
        max = max.max(count);
        if a.status != PreparationStatus::Running && b.status != PreparationStatus::Running {
            assert_eq!(a.status, PreparationStatus::Ready, "{:?}", a.error);
            assert_eq!(b.status, PreparationStatus::Ready, "{:?}", b.error);
            break;
        }
        assert!(start.elapsed() < Duration::from_secs(20));
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(max >= 3);
}

#[test]
fn oversized_groups_split_without_losing_results_and_later_runs_reuse_translations() {
    let (dir, storage, workspace) = fixture();
    fs::write(dir.path().join("oversize"), "").unwrap();
    let manager = PreparationManager::default();
    start(&manager, &storage, &workspace);
    let state = wait(&manager, &storage, &workspace.review.id, |s| {
        s.status != PreparationStatus::Running
    });
    assert_eq!(state.status, PreparationStatus::Ready, "{:?}", state.error);
    let pseudo_calls = |events: Vec<Value>| {
        events
            .into_iter()
            .filter(|e| e["event"] == "start")
            .flat_map(|e| e["items"].as_array().unwrap().clone())
            .filter(|id| id.as_str().unwrap().starts_with("pseudo:"))
            .count()
    };
    let before = pseudo_calls(calls(dir.path()));
    assert!(before > 0);
    fs::remove_file(dir.path().join("oversize")).unwrap();
    start(&manager, &storage, &workspace);
    let state = wait(&manager, &storage, &workspace.review.id, |s| {
        s.status != PreparationStatus::Running
    });
    assert_eq!(state.status, PreparationStatus::Ready, "{:?}", state.error);
    assert_eq!(
        pseudo_calls(calls(dir.path())),
        before,
        "a second preparation reuses verified translations"
    );
}
#[test]
fn rate_limits_have_a_bounded_retry_budget_and_do_not_publish() {
    let (dir, storage, workspace) = fixture();
    fs::write(dir.path().join("rate-limit"), "").unwrap();
    let manager = PreparationManager::default();
    start(&manager, &storage, &workspace);
    let state = wait(&manager, &storage, &workspace.review.id, |s| {
        s.status != PreparationStatus::Running
    });
    assert_eq!(state.status, PreparationStatus::Failed);
    assert_eq!(state.error.unwrap().code, "provider_rate_limit");
    let starts = calls(dir.path())
        .into_iter()
        .filter(|e| e["event"] == "start")
        .collect::<Vec<_>>();
    assert!(
        starts.len() <= 6,
        "two initial groups, at most three attempts each"
    );
    assert!(
        reviews::load(&storage, &workspace.review.id)
            .unwrap()
            .review
            .topics
            .is_empty()
    );
}

#[test]
fn missing_helper_stops_before_generation_without_a_model_fallback() {
    let (dir, storage, workspace) = fixture();
    fs::write(dir.path().join("missing-helper"), "").unwrap();
    let manager = PreparationManager::default();
    start(&manager, &storage, &workspace);
    let state = wait(&manager, &storage, &workspace.review.id, |s| {
        s.status != PreparationStatus::Running
    });
    assert_eq!(state.status, PreparationStatus::Failed);
    assert_eq!(state.error.unwrap().code, "translation_model");
    assert!(!calls(dir.path()).iter().any(|e| e["event"] == "start"));
}

#[test]
fn uncertain_cleanup_replaces_coordinators_without_discarding_valid_results() {
    let (dir, storage, workspace) = fixture();
    fs::write(dir.path().join("cleanup-fails"), "").unwrap();
    let manager = PreparationManager::default();
    start(&manager, &storage, &workspace);
    let state = wait(&manager, &storage, &workspace.review.id, |s| {
        s.status != PreparationStatus::Running
    });
    assert_eq!(state.status, PreparationStatus::Ready, "{:?}", state.error);
    let starts: Vec<_> = calls(dir.path())
        .into_iter()
        .filter(|e| e["event"] == "start")
        .collect();
    let processes: BTreeSet<_> = starts.iter().map(|e| e["pid"].as_u64().unwrap()).collect();
    assert_eq!(
        processes.len(),
        starts.len(),
        "uncertain sessions must never be reused"
    );
    let items: Vec<_> = starts
        .iter()
        .flat_map(|e| e["items"].as_array().unwrap())
        .map(|item| item.as_str().unwrap())
        .collect();
    assert_eq!(
        items.len(),
        items.iter().collect::<BTreeSet<_>>().len(),
        "cleanup does not regenerate valid items"
    );
}

#[test]
fn model_selection_precedes_translation_and_is_not_an_extension_filter() {
    let (dir, storage, workspace) = fixture();
    let root = dir.path().join("repo");
    for (path, text) in [
        ("README.md", "# Description\nOnly documentation.\n"),
        ("settings.json", "{\"mode\":\"light\"}\n"),
        (
            "types.ts",
            "export interface Options { enabled: boolean }\n",
        ),
        ("copy.ts", "const amount = 2;\n"),
        ("workflow.json", "{\"if\":\"ready\",\"then\":\"run\"}\n"),
    ] {
        fs::write(root.join(path), text).unwrap();
    }
    let workspace = reviews::create(
        &storage,
        CaptureRequest {
            repository_id: workspace.review.repository_id,
            scope: Scope::Local,
            base: None,
            target: None,
            include_untracked: true,
        },
    )
    .unwrap();
    let skipped = ["README.md", "settings.json", "types.ts", "copy.ts"];
    fs::write(
        dir.path().join("skip-paths"),
        serde_json::to_vec(&skipped).unwrap(),
    )
    .unwrap();
    let manager = PreparationManager::default();
    start(&manager, &storage, &workspace);
    let state = wait(&manager, &storage, &workspace.review.id, |s| {
        s.status != PreparationStatus::Running
    });
    assert_eq!(state.status, PreparationStatus::Ready, "{:?}", state.error);
    let selection = state.translation_selection.unwrap();
    assert_eq!((selection.selected_files, selection.skipped_files), (2, 4));
    let events = calls(dir.path());
    let first_start = events
        .iter()
        .position(|event| event["event"] == "start")
        .unwrap();
    let first_end = events
        .iter()
        .position(|event| event["event"] == "end")
        .unwrap();
    assert_eq!(events[first_start]["items"], json!(["outline"]));
    assert!(
        !events[first_start + 1..first_end]
            .iter()
            .any(|event| event["event"] == "start")
    );
    let mut review = reviews::load(&storage, &workspace.review.id).unwrap();
    for file in review.review.files.clone() {
        let content = reader::read_file(&storage, &review.review.id, &file.id).unwrap();
        assert!(
            content.documents.is_none(),
            "Only contextual steps have documents"
        );
        assert_eq!(
            content.pseudocode_selected == Some(false),
            skipped.contains(&file.path.as_str())
        );
        if content.pseudocode_selected == Some(false) {
            assert!(
                content.translations.is_empty(),
                "Identical cached bytes must not resurrect an omitted translation"
            );
            review = reviews::apply(
                &storage,
                &review.review.id,
                review.review.revision,
                ReviewAction::ValidateFile {
                    file_id: file.id,
                    level: ReadingLevel::Intermediate,
                },
            )
            .unwrap();
        } else {
            assert!(
                !content.translations.is_empty(),
                "A selected JSON file is translated too"
            );
        }
    }
    assert_eq!(review.review.decisions.len(), skipped.len());
}

#[test]
fn zero_selected_files_is_complete_and_only_selected_ids_are_validated() {
    let (dir, storage, workspace) = fixture();
    fs::write(dir.path().join("skip-all"), "").unwrap();
    let manager = PreparationManager::default();
    start(&manager, &storage, &workspace);
    let state = wait(&manager, &storage, &workspace.review.id, |s| {
        s.status != PreparationStatus::Running
    });
    assert_eq!(state.status, PreparationStatus::Ready, "{:?}", state.error);
    assert_eq!(state.translation_selection.unwrap().selected_files, 0);
    assert!(
        calls(dir.path())
            .iter()
            .all(|event| event["items"].as_array().is_none_or(|items| items
                .iter()
                .all(|item| !item.as_str().unwrap().starts_with("pseudo:"))))
    );
    let checkpoint = optional_checkpoint(
        &storage,
        &format!("{}:{}", workspace.review.repository_id, workspace.review.id),
    )
    .unwrap()
    .unwrap();
    let outline: Outline = serde_json::from_value(checkpoint.results["outline"].clone()).unwrap();
    validate_outline(&outline, &workspace.snapshot).unwrap();
    assert!(outline.translation_files.is_empty());
    let selected = reader::files(&workspace.snapshot)[0].id.clone();
    let mut invalid = outline.clone();
    invalid.translation_files = vec![selected.clone(), selected.clone()];
    assert!(validate_outline(&invalid, &workspace.snapshot).is_err());
    invalid.translation_files = vec!["unknown".into()];
    assert!(validate_outline(&invalid, &workspace.snapshot).is_err());
    invalid.translation_files = vec![selected];
    validate_outline(&invalid, &workspace.snapshot).unwrap();
}

#[test]
fn translation_groups_bound_file_count_without_losing_versions() {
    let units: Vec<_> = (0..20)
        .flat_map(|file| {
            (0..2).map(move |side| {
                unit(
                    format!("pseudo:{file}:{side}"),
                    format!("file-{file}"),
                    PreparationPhase::Pseudocode,
                    json!({"file":format!("file-{file}"),"text":"x".repeat(12000)}),
                    Kind::Translation(Segment {
                        start_line: 1,
                        end_line: 1,
                        text: "x".into(),
                    }),
                )
            })
        })
        .collect();
    let expected: BTreeSet<_> = units.iter().map(|unit| unit.key.clone()).collect();
    let groups = translation_groups(units);
    let mut seen = BTreeSet::new();
    for group in groups {
        assert!(
            group
                .iter()
                .map(|unit| unit.input["file"].as_str().unwrap())
                .collect::<BTreeSet<_>>()
                .len()
                <= 9
        );
        for unit in group {
            assert!(seen.insert(unit.key));
        }
    }
    assert_eq!(seen, expected);
}

#[test]
fn eight_coordinators_keep_document_capacity_while_translating_many_files() {
    let (dir, storage, first) = fixture();
    for i in 0..72 {
        fs::write(
            dir.path().join("repo").join(format!("algorithm-{i}.ts")),
            format!("export function f{i}(x) {{ return x > {i} ? x * 2 : 0; }}\n"),
        )
        .unwrap();
    }
    let workspace = reviews::create(
        &storage,
        CaptureRequest {
            repository_id: first.review.repository_id,
            scope: Scope::Local,
            base: None,
            target: None,
            include_untracked: true,
        },
    )
    .unwrap();
    // Hold document batches while translation groups saturate their own six slots.
    fs::write(dir.path().join("pause"), "").unwrap();
    fs::write(dir.path().join("pause-translations"), "").unwrap();
    let manager = PreparationManager::default();
    start(&manager, &storage, &workspace);
    let state = wait(&manager, &storage, &workspace.review.id, |state| {
        state.active_batches.len() == MAX_COORDINATORS || state.status != PreparationStatus::Running
    });
    assert_eq!(
        state.status,
        PreparationStatus::Running,
        "{:?}",
        state.error
    );
    assert_eq!(
        state
            .active_batches
            .iter()
            .filter(|batch| batch.phase == PreparationPhase::Documents)
            .count(),
        2
    );
    assert_eq!(
        state
            .active_batches
            .iter()
            .filter(|batch| batch.phase == PreparationPhase::Pseudocode)
            .count(),
        6
    );
    fs::remove_file(dir.path().join("pause")).unwrap();
    fs::remove_file(dir.path().join("pause-translations")).unwrap();
    let ready = wait(&manager, &storage, &workspace.review.id, |state| {
        state.status != PreparationStatus::Running
    });
    assert_eq!(ready.status, PreparationStatus::Ready, "{:?}", ready.error);
    assert_eq!(ready.step_titles.len(), 4);
    assert!(
        ready
            .phases
            .iter()
            .all(|phase| phase.phase != PreparationPhase::Files)
    );
    assert!(
        calls(dir.path())
            .iter()
            .filter(|event| event["event"] == "start")
            .all(|event| event["items"]
                .as_array()
                .unwrap()
                .iter()
                .all(|item| !item.as_str().unwrap().starts_with("file:")))
    );
}

#[test]
fn free_outline_accepts_empty_and_large_tours_and_long_documents() {
    let (_dir, storage, workspace) = fixture();
    let change = &workspace.snapshot.changes[0];
    let anchor = CodeAnchor {
        snapshot_id: workspace.snapshot.id.clone(),
        change_id: change.id.clone(),
        passage_id: change.passages[0].id.clone(),
    };
    let mut outline = Outline {
        topics: vec![],
        translation_files: vec![],
    };
    validate_outline(&outline, &workspace.snapshot).unwrap();
    outline.topics.push(OutlineTopic {
        title: "Topic ".repeat(100),
        brief: "Context".into(),
        steps: (0..30)
            .map(|i| OutlineStep {
                title: format!("Step {i} {}", "explanation ".repeat(40)),
                anchors: vec![anchor.clone()],
            })
            .collect(),
    });
    validate_outline(&outline, &workspace.snapshot).unwrap();
    let doc = |body| ReviewDocument {
        term_aliases: Default::default(),
        body,
        terms: vec![],
        references: vec![],
        reading_seconds: 60,
    };
    let documents = LevelDocuments {
        glossary: vec![],
        beginner: doc(format!(
            "{}\n```pseudocode\nIF ready\n  RETURN result\n```",
            "Plain explanation. ".repeat(10_000)
        )),
        intermediate: doc("Technical explanation of `a.ts`.".into()),
        developer: doc("Tradeoffs and consequences.".into()),
    };
    validate_documents(&documents, &workspace.snapshot, &storage).unwrap();
}
#[test]
fn condensed_translations_allow_gaps_and_no_logic() {
    let source = Segment {
        start_line: 1,
        end_line: 10_000,
        text: "source".into(),
    };
    validate_translation(&TranslationResult { blocks: vec![] }, &source).unwrap();
    validate_translation(
        &TranslationResult {
            blocks: vec![
                PseudoBlock {
                    start_line: 100,
                    end_line: 105,
                    text: "IF ready\n  RETURN result".into(),
                },
                PseudoBlock {
                    start_line: 999,
                    end_line: 1000,
                    text: "HANDLE failure".into(),
                },
            ],
        },
        &source,
    )
    .unwrap();
}

#[test]
fn an_empty_tour_publishes_manual_review_without_artificial_steps() {
    let (_dir, storage, workspace) = fixture();
    let contents = reader::files(&workspace.snapshot)
        .iter()
        .map(|file| ReviewFileContent {
            file_id: file.id.clone(),
            pseudocode_selected: Some(false),
            pseudocode_skip_reason: None,
            documents: None,
            translations: vec![],
        })
        .collect();
    let result = reader::publish_preparation(
        &storage,
        &workspace.review.id,
        &workspace.snapshot.id,
        "empty-tour",
        workspace.review.revision,
        vec![],
        contents,
    )
    .unwrap();
    assert_eq!(result.review.mode, ReviewMode::Manual);
    assert_eq!(result.review.position.context, ReadingContext::Files);
    assert!(result.review.topics.is_empty());
    let restored = reviews::load(&storage, &result.review.id).unwrap();
    assert!(
        restored
            .review
            .files
            .iter()
            .all(|file| file.pseudocode_selected == Some(false))
    );
}

#[test]
fn structured_generation_does_not_accept_application_owned_aliases() {
    let item = unit(
        "step:0:0".into(),
        "Step".into(),
        PreparationPhase::Documents,
        json!({}),
        Kind::Documents,
    );
    let schema = item.schema();
    assert!(
        schema["$defs"]["ReviewDocument"]["properties"]
            .get("termAliases")
            .is_none()
    );
}
