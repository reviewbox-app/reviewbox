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
  models=[{'model':'gpt-6.1-sol','displayName':'Sol','supportedReasoningEfforts':[{'reasoningEffort':'medium'}]}]
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
 prompt=params['input'][0]['text']
 assert 'Keep the three variants of a reading step with one helper' not in prompt
 if '# Write three distinct reading levels' in prompt:
  assert 'agents.enabled=false' in args
  assert 'sole writer' in prompt
  assert 'correction.items[].previousResult' in prompt
 else:
  assert 'Delegate as much independent discovery and research as possible' in prompt
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
   result={'steps':[{'draftId':'0:'+str(i),'title':'Explain amount '+str(i),'writingBrief':'Private direction '+str(i)+': explain the amount before and after this change.','contextSourceIds':[],'anchors':[change['anchors'][0]]} for i in range(int((base/'step-count').read_text()) if (base/'step-count').exists() else 4)]}
  else:
   assert data['step']['writingBrief'].startswith('Private direction '+key.rsplit(':',1)[1]+': explain the amount before and after this change.')
   assert data['step']['contextSourceIds']==[]
   assert len(data['readingPlan']) > 0
   assert any(s['draftId']==data['step']['draftId'] for s in data['readingPlan'])
   record('writing',id=key,brief=data['step']['writingBrief'])
   if (base/'descendants').exists():
    import subprocess
    child=subprocess.Popen(['sleep','90']);record('descendant',id=key,child=child.pid)
   result={level:{'body':body,'readingSeconds':30,'references':[],'terms':[]}for level,body in [('essential','The remembered amount changes.'),('explained','The stored amount now reflects the requested value.'),('technical','The assignment changes its value while retaining its public role.')]}
   if (base/'repair').exists() and key=='step:0:1':
    flag=base/'repaired'
    if not flag.exists():flag.write_text('1');result={'invalid':True}
  if key=='outline':
   for step in result['steps']:step['analysis']=dict(before='Previous value',after='Updated value',relationships='The exported value is used by its callers.',consequences='Callers observe the new amount.',uncertainties=[],evidence=[dict(fact='The captured file defines the value.',sourceId=next(s['sourceId'] for s in manifest['sources'] if s['sourceId'].startswith('change:'+step['anchors'][0]['changeId']+':') and s['sourceId'].endswith(':after')),startLine=1,endLine=1)])
  else:
   assert data['step']['analysis']['evidence']
   assert all('text' not in s for s in data['capturedSources'])
  results.append({'id':key,'result':result})
 if (base/'pause').exists() and any(i['id'].startswith('step:') for i in batch['items']):
  while (base/'pause').exists():time.sleep(.03)
 payload={'items':results}
 if (base/'stream-outline').exists() and any(i['id']=='outline' for i in batch['items']):
  text=json.dumps(payload)
  send({'method':'item/started','params':{'threadId':thread,'turnId':turn,'item':{'type':'agentMessage','id':'final','phase':'final_answer'}}})
  for offset in range(0,len(text),30):
   send({'method':'item/agentMessage/delta','params':{'threadId':thread,'turnId':turn,'itemId':'final','delta':text[offset:offset+30]}});time.sleep(.003)
  while (base/'outline-pause').exists():time.sleep(.03)
  if (base/'revise-outline').exists():
   steps=payload['items'][0]['result']['steps']
   steps[0]['writingBrief']+=' Revised.'
   steps.pop(1);steps.reverse()
  if (base/'outline-fails').exists():
   send({'method':'turn/completed','params':{'threadId':thread,'turn':{'id':turn,'status':'failed','error':{'message':'Outline rejected'}}}});continue
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
        .unwrap_or_default()
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
    assert_eq!(state.steps.len(), 4);
    assert_eq!(state.completed_batches, state.total_batches);
    let checkpoint: Checkpoint = storage
        .get(
            KIND,
            &format!("{}:{}", workspace.review.repository_id, workspace.review.id),
        )
        .unwrap();
    assert!(
        checkpoint
            .measurements
            .iter()
            .any(|m| m["phase"] == "context")
    );
    assert!(
        checkpoint
            .measurements
            .iter()
            .any(|m| m["phase"] == "finalization")
    );
    for measurement in &checkpoint.measurements {
        assert!(measurement["startedAt"].as_str().is_some());
        assert!(measurement["endedAt"].as_str().is_some());
        assert!(measurement["durationMs"].as_u64().is_some());
    }
    assert!(state.events.iter().any(|event| matches!(&event.progress, Some(AgentProgress::Delegation { model: Some(model), .. }) if model == "gpt-6-luna")));
    assert!(state.events.iter().any(|event| matches!(&event.progress, Some(AgentProgress::Delegation { id, model: Some(model), .. }) if id.ends_with("new-child") && model == "gpt-6-luna")));
    let calls = calls(dir.path());
    for event in calls.iter().filter(|event| event["event"] == "start") {
        let items = event["items"].as_array().unwrap();
        assert_eq!(items.len(), 1, "One step per writing call");
        assert!(
            items
                .iter()
                .all(|item| !item.as_str().unwrap().starts_with("file:")),
            "File explanations must never be scheduled"
        );
        assert!(
            items
                .iter()
                .all(|id| !id.as_str().unwrap().starts_with("pseudo:"))
        );
        assert_eq!(event["model"], "gpt-6.1-sol");
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
    assert_eq!(maximum, 4);
    assert!(
        processes.len() <= 5,
        "Analysis and writer processes have separate delegation policies"
    );
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
    let (a_dir, first, wa) = fixture();
    let (b_dir, second, wb) = fixture();
    // Hold document responses until all global slots are observed. A fixed
    // subprocess sleep cannot guarantee overlap on a loaded CI runner.
    fs::write(a_dir.path().join("pause"), "").unwrap();
    fs::write(b_dir.path().join("pause"), "").unwrap();
    let mut released = false;
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
        if count == MAX_COORDINATORS && !released {
            fs::remove_file(a_dir.path().join("pause")).unwrap();
            fs::remove_file(b_dir.path().join("pause")).unwrap();
            released = true;
        }
        if a.status != PreparationStatus::Running && b.status != PreparationStatus::Running {
            assert_eq!(a.status, PreparationStatus::Ready, "{:?}", a.error);
            assert_eq!(b.status, PreparationStatus::Ready, "{:?}", b.error);
            break;
        }
        assert!(start.elapsed() < Duration::from_secs(20));
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(max, MAX_COORDINATORS);
}

#[test]
fn oversized_document_groups_split_without_losing_results() {
    let (dir, storage, workspace) = fixture();
    fs::write(dir.path().join("oversize"), "").unwrap();
    let manager = PreparationManager::default();
    start(&manager, &storage, &workspace);
    let state = wait(&manager, &storage, &workspace.review.id, |s| {
        s.status != PreparationStatus::Running
    });
    assert_eq!(state.status, PreparationStatus::Ready, "{:?}", state.error);
    assert!(
        calls(dir.path())
            .iter()
            .filter(|event| event["event"] == "start")
            .all(|event| event["items"]
                .as_array()
                .unwrap()
                .iter()
                .all(|id| !id.as_str().unwrap().starts_with("pseudo:")))
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
    assert_eq!(state.error.unwrap().code, "helper_model");
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
fn free_outline_accepts_empty_and_large_tours_and_long_documents() {
    let (_dir, storage, workspace) = fixture();
    let change = &workspace.snapshot.changes[0];
    let anchor = CodeAnchor {
        snapshot_id: workspace.snapshot.id.clone(),
        change_id: change.id.clone(),
        passage_id: change.passages[0].id.clone(),
    };
    let mut outline = Outline {
        working_context_assessments: vec![],
        removed_steps: vec![],
        topics: vec![],
    };
    validate_outline(&outline, &workspace.snapshot).unwrap();
    outline.topics.push(OutlineTopic {
        title: "Topic ".repeat(100),
        brief: "Context".into(),
        steps: (0..30)
            .map(|i| OutlineStep {
                draft_id: format!("0:{i}"),
                previous_step_id: None,
                reuse: false,
                title: format!("Step {i} {}", "explanation ".repeat(40)),
                analysis: None,
                writing_brief: format!("Explain behavior {i} before and after the change."),
                context_source_ids: vec![],
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
        dependencies: None,
        context_sources: vec![],
        glossary: vec![],
        essential: doc(format!(
            "{}\nThe result is returned when ready.",
            "Plain explanation. ".repeat(10_000)
        )),
        explained: doc("Technical explanation of `a.ts`.".into()),
        technical: doc("Tradeoffs and consequences.".into()),
    };
    validate_documents(&documents, &workspace.snapshot, &storage).unwrap();
}
#[test]
fn document_glossary_accepts_unused_definitions_but_rejects_broken_links() {
    let (_dir, storage, workspace) = fixture();
    let term = |id: &str| DocumentTerm {
        id: id.into(),
        term: "Atomic publication".into(),
        definition: "Make the complete bundle visible together.".into(),
        context: "Publishing a completed review.".into(),
    };
    let doc = |body: &str| ReviewDocument {
        term_aliases: Default::default(),
        body: body.into(),
        terms: vec![],
        references: vec![],
        reading_seconds: 60,
    };
    let mut documents = LevelDocuments {
        dependencies: None,
        context_sources: vec![],
        glossary: vec![term("shared")],
        essential: doc("The finished review becomes available."),
        explained: doc("The bundle is published after validation."),
        technical: doc("The writer commits the verified bundle."),
    };
    documents.technical.terms.push(term("local"));
    // Neither declared term occurs in any variant. This used to exhaust repairs.
    validate_documents(&documents, &workspace.snapshot, &storage).unwrap();
    for body in [
        "Understand atomic publication.",
        "Understand [the operation](reviewbox:term/shared).",
    ] {
        documents.essential.body = body.into();
        validate_documents(&documents, &workspace.snapshot, &storage).unwrap();
    }
    documents.essential.body = "Read [the meaning](reviewbox:term/missing).".into();
    assert_eq!(
        validate_documents(&documents, &workspace.snapshot, &storage)
            .unwrap_err()
            .code,
        "invalid_term"
    );
    documents.essential.body = "Read [the source](reviewbox:ref/missing).".into();
    assert_eq!(
        validate_documents(&documents, &workspace.snapshot, &storage)
            .unwrap_err()
            .code,
        "invalid_reference"
    );
    documents.essential.body = "The finished review becomes available.".into();
    documents.glossary.push(term("shared"));
    assert!(validate_documents(&documents, &workspace.snapshot, &storage).is_err());
    documents.glossary.pop();
    documents.glossary[0].definition.clear();
    assert!(validate_documents(&documents, &workspace.snapshot, &storage).is_err());
}

#[test]
fn an_empty_tour_publishes_manual_review_without_artificial_steps() {
    let (_dir, storage, workspace) = fixture();
    let contents = reader::files(&workspace.snapshot)
        .iter()
        .map(|file| ReviewFileContent {
            file_id: file.id.clone(),
            documents: None,
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
    assert!(restored.review.files.iter().all(|file| !file.has_documents));
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

#[test]
fn preparation_needs_only_the_project_and_selected_helper_models() {
    let (dir, storage, workspace) = fixture();
    let executable = dir.path().join("parallel-codex");
    let script = fs::read_to_string(&executable).unwrap().replace(
        "'supportedReasoningEfforts':[{'reasoningEffort':'medium'}]",
        "'supportedReasoningEfforts':[{'reasoningEffort':'medium'},{'reasoningEffort':'high'}]",
    );
    fs::write(&executable, script).unwrap();
    fs::write(dir.path().join("missing-helper"), "").unwrap();
    let mut settings = agents::settings(&storage).unwrap();
    settings.helper_model = "gpt-6.1-sol".into();
    agents::configure(&storage, settings).unwrap();
    let manager = PreparationManager::default();
    start(&manager, &storage, &workspace);
    let state = wait(&manager, &storage, &workspace.review.id, |s| {
        s.status != PreparationStatus::Running
    });
    assert_eq!(state.status, PreparationStatus::Ready, "{:?}", state.error);
    assert!(
        !storage
            .root()
            .join("translation-cache-logic-v2.sqlite3")
            .exists()
    );
    assert!(
        calls(dir.path())
            .iter()
            .filter(|e| e["event"] == "start")
            .all(|e| e["model"] == "gpt-6.1-sol")
    );
}

#[test]
fn writing_briefs_validate_and_source_content_is_never_injected() {
    let (_dir, _storage, mut workspace) = fixture();
    let change = &workspace.snapshot.changes[0];
    let mut content = change.after.clone().unwrap();
    content.hash = "supplemental-content".into();
    content.size = 65_537;
    let anchor = CodeAnchor {
        snapshot_id: workspace.snapshot.id.clone(),
        change_id: change.id.clone(),
        passage_id: change.passages[0].id.clone(),
    };
    workspace.snapshot.files.push(SnapshotFile {
        path: "context.ts".into(),
        content,
    });
    let context_id = "file:context.ts".to_owned();
    let mut outline = Outline {
        working_context_assessments: vec![],
        removed_steps: vec![],
        topics: vec![OutlineTopic {
            title: "Amounts".into(),
            brief: "Public behavior".into(),
            steps: vec![OutlineStep {
                draft_id: "0:0".into(),
                previous_step_id: None,
                reuse: false,
                title: "New amount".into(),
                analysis: None,
                writing_brief:
                    "Private note: explain the old and new amount and the effect of context.ts."
                        .into(),
                context_source_ids: vec![context_id.clone()],
                anchors: vec![anchor.clone()],
            }],
        }],
    };
    validate_outline(&outline, &workspace.snapshot).unwrap();
    let step = &outline.topics[0].steps[0];
    let schema = unit(
        "outline".into(),
        "Outline".into(),
        PreparationPhase::Outline,
        json!({}),
        Kind::Outline,
    )
    .schema();
    assert!(
        schema["properties"]["items"]["items"]["properties"]["result"]["properties"]["steps"]
            .is_object()
    );
    assert!(
        schema["properties"]["items"]["items"]["properties"]["result"]["properties"]
            .get("topics")
            .is_none()
    );
    let required = schema["$defs"]["OutlineStep"]["required"]
        .as_array()
        .unwrap();
    assert!(required.contains(&json!("writingBrief")));
    assert!(required.contains(&json!("contextSourceIds")));
    let mut missing_note = serde_json::to_value(&outline).unwrap();
    missing_note["topics"][0]["steps"][0]
        .as_object_mut()
        .unwrap()
        .remove("writingBrief");
    assert!(serde_json::from_value::<Outline>(missing_note).is_err());

    let sources = reader::sources(&workspace.snapshot);
    let input = document_input(&outline.topics[0], step, &sources);
    assert_eq!(input["step"]["writingBrief"], step.writing_brief);
    let evidence = input["capturedSources"].as_array().unwrap();
    assert!(evidence.iter().any(|s| s["sourceId"] == context_id));
    assert!(
        evidence
            .iter()
            .all(|s| s["readFromManifest"] == true && s.get("text").is_none())
    );

    let mut docs = LevelDocuments::default();
    adaptation::attach_dependencies(
        &mut docs,
        &step.anchors,
        &step.context_source_ids,
        &workspace.snapshot,
        "signature",
    )
    .unwrap();
    assert!(
        docs.dependencies
            .as_ref()
            .unwrap()
            .sources
            .iter()
            .any(|s| s.source_id == context_id)
    );
    assert_eq!(
        serde_json::to_value(&step.anchors).unwrap(),
        json!([anchor])
    );
    adaptation::attach_dependencies(
        &mut docs,
        &step.anchors,
        &[],
        &workspace.snapshot,
        "signature",
    )
    .unwrap();
    assert!(
        docs.dependencies
            .as_ref()
            .unwrap()
            .sources
            .iter()
            .any(|s| s.source_id == context_id),
        "Reassembly preserves coordinator-only dependencies"
    );
    let published = serde_json::to_value(&docs).unwrap().to_string();
    assert!(!published.contains("Private note"));
    assert!(!published.contains("writingBrief"));
    assert!(
        docs.context_sources.is_empty(),
        "Coordinator dependencies do not become authored prose or references"
    );

    for ids in [
        vec!["unknown".into()],
        vec![context_id.clone(), context_id.clone()],
    ] {
        outline.topics[0].steps[0].context_source_ids = ids;
        assert!(validate_outline(&outline, &workspace.snapshot).is_err());
    }
    outline.topics[0].steps[0].context_source_ids.clear();
    validate_outline(&outline, &workspace.snapshot).unwrap();
    outline.topics[0].steps[0].writing_brief = " \n ".into();
    assert!(validate_outline(&outline, &workspace.snapshot).is_err());
}

#[test]
fn writers_wait_for_the_final_plan_and_receive_its_final_order() {
    let (dir, storage, workspace) = fixture();
    for flag in ["stream-outline", "outline-pause", "pause", "revise-outline"] {
        fs::write(dir.path().join(flag), "").unwrap();
    }
    let manager = PreparationManager::default();
    start(&manager, &storage, &workspace);
    wait(&manager, &storage, &workspace.review.id, |s| {
        !s.active_batches.is_empty()
    });
    std::thread::sleep(std::time::Duration::from_millis(500));
    assert!(!calls(dir.path()).iter().any(|c| c["event"] == "writing"));
    fs::remove_file(dir.path().join("outline-pause")).unwrap();
    let writing = wait(&manager, &storage, &workspace.review.id, |s| {
        s.steps.len() == 3
            && s.steps
                .iter()
                .all(|s| s.status == PreparationStepStatus::Writing)
    });
    assert_eq!(
        writing
            .steps
            .iter()
            .map(|s| s.id.as_str())
            .collect::<Vec<_>>(),
        vec!["step:0:3", "step:0:2", "step:0:0"]
    );
    fs::remove_file(dir.path().join("pause")).unwrap();
    let ready = wait(&manager, &storage, &workspace.review.id, |s| {
        s.status != PreparationStatus::Running
    });
    assert_eq!(ready.status, PreparationStatus::Ready, "{:?}", ready.error);
    assert!(
        !calls(dir.path())
            .iter()
            .any(|c| c["event"] == "writing" && c["id"] == "step:0:1")
    );
    let review = reviews::load(&storage, &workspace.review.id)
        .unwrap()
        .review;
    assert_eq!(review.topics.len(), 3);
    assert!(review.topics.iter().all(|t| t.steps.len() == 1));
}

#[test]
fn failed_final_analysis_never_starts_writers() {
    let (dir, storage, workspace) = fixture();
    for flag in ["stream-outline", "outline-fails"] {
        fs::write(dir.path().join(flag), "").unwrap();
    }
    let manager = PreparationManager::default();
    start(&manager, &storage, &workspace);
    let failed = wait(&manager, &storage, &workspace.review.id, |s| {
        s.status != PreparationStatus::Running
    });
    assert_eq!(failed.status, PreparationStatus::Failed);
    assert!(!calls(dir.path()).iter().any(|c| c["event"] == "writing"));
    assert!(
        reviews::load(&storage, &workspace.review.id)
            .unwrap()
            .review
            .topics
            .is_empty()
    );
}

#[test]
fn two_finalized_plans_share_eight_writer_slots() {
    let (a, sa, wa) = fixture();
    let (b, sb, wb) = fixture();
    for dir in [&a, &b] {
        fs::write(dir.path().join("step-count"), "12").unwrap();
        fs::write(dir.path().join("pause"), "").unwrap();
    }
    let manager = PreparationManager::default();
    start(&manager, &sa, &wa);
    start(&manager, &sb, &wb);
    wait(&manager, &sa, &wa.review.id, |left| {
        let right = manager.get(&sb, &wb.review.id, None).unwrap().unwrap();
        let count = left.active_batches.len() + right.active_batches.len();
        assert!(count <= 8);
        count == 8
    });
    for dir in [&a, &b] {
        fs::remove_file(dir.path().join("pause")).unwrap();
    }
    for (storage, workspace) in [(&sa, &wa), (&sb, &wb)] {
        let state = wait(&manager, storage, &workspace.review.id, |s| {
            s.status != PreparationStatus::Running
        });
        assert_eq!(state.status, PreparationStatus::Ready, "{:?}", state.error);
    }
}

#[test]
fn analysis_dossier_validates_sources_ranges_and_legacy_decoding() {
    let (_dir, storage, workspace) = fixture();
    let change = &workspace.snapshot.changes[0];
    let source = reader::sources(&workspace.snapshot)
        .into_iter()
        .find(|s| s.source_id.ends_with(":after"))
        .unwrap();
    let mut outline = Outline {
        working_context_assessments: vec![],
        removed_steps: vec![],
        topics: vec![OutlineTopic {
            title: "Value".into(),
            brief: "Value".into(),
            steps: vec![OutlineStep {
                draft_id: "value".into(),
                previous_step_id: None,
                reuse: false,
                title: "Value".into(),
                writing_brief: "Explain value".into(),
                context_source_ids: vec![],
                anchors: vec![CodeAnchor {
                    snapshot_id: workspace.snapshot.id.clone(),
                    change_id: change.id.clone(),
                    passage_id: change.passages[0].id.clone(),
                }],
                analysis: Some(JourneyAnalysis {
                    before: "Old value".into(),
                    after: "New value".into(),
                    relationships: "Caller receives value".into(),
                    consequences: "Updated result".into(),
                    uncertainties: vec![],
                    evidence: vec![AnalysisEvidence {
                        fact: "The value is updated".into(),
                        source_id: source.source_id.clone(),
                        start_line: 1,
                        end_line: 1,
                    }],
                }),
            }],
        }],
    };
    validate_analysis(&outline, &workspace.snapshot, &storage).unwrap();
    let input = document_input(
        &outline.topics[0],
        &outline.topics[0].steps[0],
        &reader::sources(&workspace.snapshot),
    );
    assert_eq!(
        input["step"]["analysis"]["evidence"][0]["fact"],
        "The value is updated"
    );
    outline.topics[0].steps[0]
        .analysis
        .as_mut()
        .unwrap()
        .evidence[0]
        .end_line = 9999;
    assert!(validate_analysis(&outline, &workspace.snapshot, &storage).is_err());
    outline.topics[0].steps[0]
        .analysis
        .as_mut()
        .unwrap()
        .evidence[0]
        .source_id = "missing".into();
    assert!(validate_analysis(&outline, &workspace.snapshot, &storage).is_err());
    outline.topics[0].steps[0]
        .analysis
        .as_mut()
        .unwrap()
        .evidence
        .clear();
    assert!(
        validate_analysis(&outline, &workspace.snapshot, &storage).is_err(),
        "Text changes still need exact evidence"
    );
    let mut metadata = workspace.snapshot.clone();
    for passage in &mut metadata.changes[0].passages {
        passage.old_lines = 0;
        passage.new_lines = 0;
    }
    validate_outline(&outline, &metadata).unwrap();
    validate_analysis(&outline, &metadata, &storage).unwrap();
    metadata.changes[0].binary = true;
    validate_analysis(&outline, &metadata, &storage).unwrap();
    let mut legacy = serde_json::to_value(&outline).unwrap();
    legacy["topics"][0]["steps"][0]
        .as_object_mut()
        .unwrap()
        .remove("analysis");
    let legacy: Outline = serde_json::from_value(legacy).unwrap();
    assert!(validate_analysis(&legacy, &workspace.snapshot, &storage).is_err());
}
