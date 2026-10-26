use super::*;
use std::os::unix::fs::PermissionsExt;
fn fixture() -> (tempfile::TempDir, Storage, Workspace) {
    let (dir, storage, workspace) = crate::preparation::tests::native::fixture();
    let script = dir.path().join("session-codex");
    std::fs::write(&script,r#"#!/usr/bin/env python3
import json,sys,pathlib,socket,time
args=sys.argv[1:]
def send(v): print(json.dumps(v),flush=True)
if args==['--version']: print('codex-cli 0.159.2');sys.exit(0)
if 'generate-json-schema' in args:
 p=pathlib.Path(args[args.index('--out')+1])/'v2';p.mkdir(parents=True,exist_ok=True)
 (p/'ThreadStartParams.json').write_text(json.dumps({'properties':{'ephemeral':{'type':'boolean'}},'definitions':{'SandboxMode':{'enum':['read-only','danger-full-access']}}}));sys.exit(0)
for line in sys.stdin:
 v=json.loads(line); m=v.get('method'); i=v.get('id')
 if m=='initialize':send({'id':i,'result':{}})
 elif m=='model/list':send({'id':i,'result':{'data':[{'model':'test','displayName':'Test','supportedReasoningEfforts':[{'reasoningEffort':'low'}]}],'nextCursor':None}})
 elif m=='config/read':send({'id':i,'result':{'config':{}}})
 elif m=='thread/start':
  assert v['params']['sandbox']=='read-only'
  config=v['params']['config'];assert config['agents.enabled'] is True and config['features.shell_tool'] is False
  server=config['mcp_servers']['reviewbox_preparation'];address=server['args'][1];token=server['env']['REVIEWBOX_SESSION_TOKEN']
  send({'id':i,'result':{'thread':{'id':'root','ephemeral':True}}})
 elif m=='turn/start':
  assert 'outputSchema' not in v['params']
  send({'id':i,'result':{'turn':{'id':'turn'}}})
  def call(name,args):
   host,port=address.split(':')
   with socket.create_connection((host,int(port))) as s:
    s.sendall((json.dumps({'token':token,'name':name,'arguments':args})+'\n').encode())
    result=json.loads(s.makefile().readline())
    assert not result['isError'],result
    return result['structuredContent']
  state=call('review_state',{});change=state['changes'][0]
  call('review_plan',{'requestId':'plan','revision':0,'steps':[{'id':'amount','title':'Amount'}]})
  call('review_activity',{'text':'Writing the amount change','stepId':'amount'})
  call('review_document',{'requestId':'doc','revision':1,'stepId':'amount','anchors':[{'snapshotId':state['snapshotId'],'changeId':change['id'],'passageId':change['passages'][0]['id']}],'document':{'body':'The amount changes to two.','references':[],'terms':[],'readingSeconds':1}})
  base=pathlib.Path(sys.argv[0]).parent
  with (base/'turns').open('a') as f:f.write('turn\n')
  while (base/'hold').exists():time.sleep(.03)
  if (base/'rate-limit').exists():
   send({'method':'turn/completed','params':{'threadId':'root','turn':{'id':'turn','status':'failed','error':{'message':'429 Too Many Requests','codexErrorInfo':{'responseTooManyFailedAttempts':{'httpStatusCode':429}}}}}});continue
  call('review_finish',{'requestId':'done','revision':2,'summary':'Ready for human review.'})
  send({'method':'item/completed','params':{'threadId':'root','turnId':'turn','item':{'id':'final','type':'agentMessage','phase':'final_answer','text':'Done'}}})
  send({'method':'turn/completed','params':{'threadId':'root','turn':{'id':'turn','status':'completed'}}})
 elif m=='thread/unsubscribe':send({'id':i,'result':{'status':'unsubscribed'}})
"#).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut settings = agents::settings(&storage).unwrap();
    let provider = settings
        .providers
        .iter_mut()
        .find(|p| p.provider == "codex")
        .unwrap();
    provider.executable = script.to_string_lossy().into();
    provider.model = Some("test".into());
    agents::configure(&storage, settings).unwrap();
    (dir, storage, workspace)
}
fn resources() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/agents")
}
fn wait(manager: &PreparationManager, storage: &Storage, review: &str) -> PreparationState {
    let start = std::time::Instant::now();
    loop {
        let state = manager.get(storage, review, None).unwrap().unwrap();
        if state.status != PreparationStatus::Running {
            return state;
        }
        assert!(
            start.elapsed() < std::time::Duration::from_secs(30),
            "{:?}",
            state.error
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}
#[test]
fn one_codex_turn_drives_tools_and_publishes_only_after_finish() {
    let (_dir, storage, workspace) = fixture();
    let manager = PreparationManager::default();
    manager
        .start(
            storage.clone(),
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/agents"),
            PreparationRequest {
                review_id: workspace.review.id.clone(),
                provider: "codex".into(),
            },
        )
        .unwrap();
    let start = std::time::Instant::now();
    loop {
        let state = manager
            .get(&storage, &workspace.review.id, None)
            .unwrap()
            .unwrap();
        if state.status != PreparationStatus::Running {
            assert_eq!(
                state.status,
                PreparationStatus::Ready,
                "{:?} events: {:?}",
                state.error,
                state.events
            );
            break;
        }
        assert!(
            start.elapsed() < std::time::Duration::from_secs(30),
            "{:?}",
            state.error
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let ready = reviews::load(&storage, &workspace.review.id).unwrap();
    assert_eq!(ready.review.topics.len(), 1);
    assert!(ready.review.topics[0].steps[0].documents.single.is_some());
}

#[test]
fn terminal_429_keeps_documents_without_automatic_retry_and_resumes_explicitly() {
    let (dir, storage, workspace) = fixture();
    std::fs::write(dir.path().join("rate-limit"), "").unwrap();
    let manager = PreparationManager::default();
    manager
        .start(
            storage.clone(),
            resources(),
            PreparationRequest {
                review_id: workspace.review.id.clone(),
                provider: "codex".into(),
            },
        )
        .unwrap();
    let failed = wait(&manager, &storage, &workspace.review.id);
    assert_eq!(failed.status, PreparationStatus::Failed);
    assert_eq!(failed.error.unwrap().code, "provider_rate_limit");
    assert_eq!(
        std::fs::read_to_string(dir.path().join("turns"))
            .unwrap()
            .lines()
            .count(),
        1
    );
    assert!(
        reviews::load(&storage, &workspace.review.id)
            .unwrap()
            .review
            .topics
            .is_empty()
    );
    std::fs::remove_file(dir.path().join("rate-limit")).unwrap();
    manager
        .resume(storage.clone(), resources(), &workspace.review.id)
        .unwrap();
    let ready = wait(&manager, &storage, &workspace.review.id);
    assert_eq!(ready.status, PreparationStatus::Ready, "{:?}", ready.error);
    assert_eq!(
        reviews::load(&storage, &workspace.review.id)
            .unwrap()
            .review
            .topics
            .len(),
        1
    );
}

#[test]
#[ignore = "Uses an authenticated real provider; run explicitly with REVIEWBOX_REAL_PROVIDER and REVIEWBOX_TEST_MCP_EXE"]
fn real_harness_receives_private_mcp_and_finishes_a_synthetic_review() {
    let (_dir, storage, workspace) = crate::preparation::tests::native::fixture();
    let provider =
        std::env::var("REVIEWBOX_REAL_PROVIDER").expect("Choose codex or claude explicitly");
    assert!(std::env::var_os("REVIEWBOX_TEST_MCP_EXE").is_some());
    let mut settings = agents::settings(&storage).unwrap();
    let config = settings
        .providers
        .iter_mut()
        .find(|p| p.provider == provider)
        .unwrap();
    config.executable = provider.clone();
    agents::configure(&storage, settings).unwrap();
    let real_resources = if std::env::var_os("REVIEWBOX_TEST_DELEGATION").is_some() {
        let path = _dir.path().join("delegation-resources");
        std::fs::create_dir_all(path.join("preparation")).unwrap();
        let prompt = std::fs::read_to_string(resources().join("preparation/session.md")).unwrap();
        std::fs::write(path.join("preparation/session.md"), format!("{prompt}\nFor this integration verification, delegate one short read-only analysis to a helper, wait for its answer, then write and finish yourself. The helper must not call document mutation tools.\n")).unwrap();
        path
    } else {
        resources()
    };
    let manager = PreparationManager::default();
    manager
        .start(
            storage.clone(),
            real_resources,
            PreparationRequest {
                review_id: workspace.review.id.clone(),
                provider,
            },
        )
        .unwrap();
    let start = std::time::Instant::now();
    loop {
        let state = manager
            .get(&storage, &workspace.review.id, None)
            .unwrap()
            .unwrap();
        if state.status != PreparationStatus::Running {
            assert_eq!(
                state.status,
                PreparationStatus::Ready,
                "{:?} events: {:?}",
                state.error,
                state.events
            );
            if std::env::var_os("REVIEWBOX_TEST_DELEGATION").is_some() {
                assert!(
                    state
                        .events
                        .iter()
                        .any(|e| matches!(e.progress, Some(AgentProgress::Delegation { .. }))),
                    "Harness did not report delegation"
                );
            }
            break;
        }
        if start.elapsed() > std::time::Duration::from_secs(240) {
            manager.cancel(&storage, &workspace.review.id).unwrap();
            panic!("Real provider timeout");
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    let ready = reviews::load(&storage, &workspace.review.id).unwrap();
    assert!(!ready.review.topics.is_empty());
    assert!(
        ready
            .review
            .topics
            .iter()
            .flat_map(|t| &t.steps)
            .all(|s| s.documents.single.is_some())
    );
}

#[test]
fn cancellation_keeps_acknowledged_work_and_restarts_without_duplicate_documents() {
    let (dir, storage, workspace) = fixture();
    std::fs::write(dir.path().join("hold"), "").unwrap();
    let manager = PreparationManager::default();
    manager
        .start(
            storage.clone(),
            resources(),
            PreparationRequest {
                review_id: workspace.review.id.clone(),
                provider: "codex".into(),
            },
        )
        .unwrap();
    let start = std::time::Instant::now();
    while !dir.path().join("turns").exists() {
        assert!(start.elapsed() < std::time::Duration::from_secs(15));
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    manager.cancel(&storage, &workspace.review.id).unwrap();
    assert_eq!(
        wait(&manager, &storage, &workspace.review.id).status,
        PreparationStatus::Cancelled
    );
    std::fs::remove_file(dir.path().join("hold")).unwrap();
    let restarted = PreparationManager::default();
    restarted
        .resume(storage.clone(), resources(), &workspace.review.id)
        .unwrap();
    let ready = wait(&restarted, &storage, &workspace.review.id);
    assert_eq!(ready.status, PreparationStatus::Ready, "{:?}", ready.error);
    assert_eq!(
        reviews::load(&storage, &workspace.review.id)
            .unwrap()
            .review
            .topics
            .len(),
        1
    );
}
