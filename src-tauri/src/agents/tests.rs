use super::*;
use serde_json::json;
use std::{fs, path::Path, process::Command};

fn git(root: &Path, args: &[&str]) {
    let output = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
fn fixture() -> (
    tempfile::TempDir,
    Storage,
    Repository,
    Workspace,
    AgentRequest,
) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("project");
    fs::create_dir(&root).unwrap();
    git(&root, &["init", "-q"]);
    git(&root, &["config", "user.email", "test@example.invalid"]);
    git(&root, &["config", "user.name", "ReviewBox test"]);
    fs::write(root.join("code.ts"), "export const answer = 1;\n").unwrap();
    git(&root, &["add", "."]);
    git(
        &root,
        &["-c", "commit.gpgsign=false", "commit", "-qm", "initial"],
    );
    fs::write(root.join("code.ts"), "export const answer = 2;\n").unwrap();
    git(&root, &["add", "code.ts"]);
    fs::write(root.join("code.ts"), "export const answer = 3;\n").unwrap();
    fs::write(
        root.join("large.ts"),
        format!("//SENTINEL_NOT_IN_PROMPT{}", "x".repeat(600 * 1024)),
    )
    .unwrap();
    let storage = Storage::open(directory.path().join("data")).unwrap();
    let repository = crate::repositories::open(&storage, root.to_str().unwrap()).unwrap();
    let workspace = reviews::create(
        &storage,
        CaptureRequest {
            repository_id: repository.id.clone(),
            scope: Scope::Local,
            base: None,
            target: None,
            include_untracked: true,
        },
    )
    .unwrap();
    let request = AgentRequest {
        id: id(),
        review_id: workspace.review.id.clone(),
        provider: "codex".into(),
        action: "topics".into(),
        request: String::new(),
        paths: vec![],
    };
    (directory, storage, repository, workspace, request)
}
fn resources() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/agents")
}
fn manifest(run: &AgentRun) -> PathBuf {
    let line = run
        .prompt
        .text
        .lines()
        .find(|line| line.trim().starts_with("\"reviewManifest\":"))
        .unwrap();
    serde_json::from_str(line.split_once(':').unwrap().1.trim().trim_end_matches(',')).unwrap()
}

#[test]
fn continuity_survives_restart_is_scoped_and_keeps_full_exchanges_off_the_prompt() {
    let (directory, storage, repository, workspace, request) = fixture();
    for index in 0..4 {
        let mut run = prepare(&storage, &resources(), &request).unwrap();
        run.id = format!("previous-{index}");
        run.request = Some(format!("Question {index} with {{{{literal}}}}"));
        run.status = if index == 3 { "cancelled" } else { "completed" }.into();
        run.created_at = format!("2026-09-27T10:00:0{index}Z");
        run.output = format!("Answer {index}: {} FULL_ANSWER_END", "é".repeat(5000));
        run.snapshot_id = "previous-snapshot".into();
        let mut value = serde_json::to_value(&run).unwrap();
        if index == 0 {
            value.as_object_mut().unwrap().remove("request");
        }
        storage.insert("agent_run", &run.id, &value).unwrap();
    }
    for (run_id, review_id, status) in [
        ("unrelated", "other-review", "completed"),
        ("in-progress", request.review_id.as_str(), "running"),
    ] {
        let mut run = prepare(&storage, &resources(), &request).unwrap();
        run.id = run_id.into();
        run.review_id = review_id.into();
        run.status = status.into();
        run.output = "DO_NOT_INJECT".into();
        storage.insert("agent_run", &run.id, &run).unwrap();
    }
    let run = prepare(&storage, &resources(), &request).unwrap();
    assert!(run.prompt.text.contains("Question 3 with {{literal}}"));
    assert!(run.prompt.text.contains("previous-snapshot"));
    assert!(run.prompt.text.contains("cancelled"));
    assert!(!run.prompt.text.contains("FULL_ANSWER_END"));
    assert!(!run.prompt.text.contains("DO_NOT_INJECT"));
    assert!(run.prompt.text.len() < 24_000);
    let path = manifest(&run);
    let exploration =
        exploration::materialize(&storage, &workspace, &request, &AtomicBool::new(false)).unwrap();
    let context_root = path.parent().unwrap();
    let index: Value =
        serde_json::from_slice(&fs::read(context_root.join("conversation.json")).unwrap()).unwrap();
    let exchanges = index["exchanges"].as_array().unwrap();
    assert_eq!(exchanges.len(), 4);
    let legacy: Value =
        serde_json::from_slice(&fs::read(exchanges[0]["exchangeFile"].as_str().unwrap()).unwrap())
            .unwrap();
    assert!(legacy["request"].is_null());
    assert!(legacy["legacyPrompt"].is_string());
    let latest: Value =
        serde_json::from_slice(&fs::read(exchanges[3]["exchangeFile"].as_str().unwrap()).unwrap())
            .unwrap();
    assert!(latest.get("legacyPrompt").is_none());
    assert!(
        latest["answer"]
            .as_str()
            .unwrap()
            .ends_with("FULL_ANSWER_END")
    );
    let review: Review =
        serde_json::from_slice(&fs::read(context_root.join("review.json")).unwrap()).unwrap();
    assert_eq!(review.id, workspace.review.id);
    drop(exploration);
    assert!(!context_root.exists());
    drop(storage);
    let reopened = Storage::open(directory.path().join("data")).unwrap();
    crate::repositories::open(&reopened, &repository.path).unwrap();
    let resumed = prepare(&reopened, &resources(), &request).unwrap();
    assert!(resumed.prompt.text.contains("Question 3 with {{literal}}"));
    let legacy: AgentRun = reopened.get("agent_run", "previous-0").unwrap();
    assert_eq!(legacy.request, None);
}

#[test]
fn large_review_is_discovered_on_demand_without_inline_source_or_a_repository_copy() {
    let (_directory, storage, repository, workspace, request) = fixture();
    let run = prepare(&storage, &resources(), &request).unwrap();
    assert!(run.prompt.text.len() < 16000);
    assert!(!run.prompt.text.contains("SENTINEL_NOT_IN_PROMPT"));
    let path = manifest(&run);
    assert!(!path.exists(), "preview does not materialize files");
    let index_before = fs::read(Path::new(&repository.path).join(".git/index")).unwrap();
    let exploration =
        exploration::materialize(&storage, &workspace, &request, &AtomicBool::new(false)).unwrap();
    assert_eq!(exploration.project, PathBuf::from(&repository.path));
    let manifest: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let staged = manifest["changes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["layer"] == "staged")
        .unwrap();
    let metadata: Value =
        serde_json::from_slice(&fs::read(staged["metadata"].as_str().unwrap()).unwrap()).unwrap();
    assert_eq!(
        fs::read_to_string(metadata["after"]["path"].as_str().unwrap()).unwrap(),
        "export const answer = 2;\n"
    );
    assert_eq!(metadata["anchors"][0]["snapshotId"], workspace.snapshot.id);
    assert!(
        metadata["after"]["path"]
            .as_str()
            .unwrap()
            .contains("/blobs/")
    );
    assert_eq!(
        fs::read_to_string(exploration.project.join("code.ts")).unwrap(),
        "export const answer = 3;\n"
    );
    assert_eq!(
        fs::read(exploration.project.join(".git/index")).unwrap(),
        index_before
    );
    drop(exploration);
    assert!(!path.exists(), "temporary discovery metadata is cleaned up");
}

#[test]
fn missing_frozen_evidence_is_explicit_and_cancelled_preparation_cleans_up() {
    let (_directory, storage, _repository, workspace, request) = fixture();
    let staged = workspace
        .snapshot
        .changes
        .iter()
        .find(|c| c.layer == "staged")
        .unwrap();
    let hash = &staged.after.as_ref().unwrap().hash;
    fs::write(
        storage.root().join("blobs").join(hash),
        "corrupt cached content",
    )
    .unwrap();
    let run = prepare(&storage, &resources(), &request).unwrap();
    let path = manifest(&run);
    let exploration =
        exploration::materialize(&storage, &workspace, &request, &AtomicBool::new(false)).unwrap();
    let manifest: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let staged = manifest["changes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["layer"] == "staged")
        .unwrap();
    let metadata: Value =
        serde_json::from_slice(&fs::read(staged["metadata"].as_str().unwrap()).unwrap()).unwrap();
    assert!(metadata["after"]["unavailable"].is_string());
    assert!(metadata["after"].get("path").is_none());
    drop(exploration);
    assert!(
        exploration::materialize(&storage, &workspace, &request, &AtomicBool::new(true)).is_err()
    );
    assert!(!path.parent().unwrap().exists());
}

#[cfg(unix)]
#[test]
fn codex_requires_ephemeral_support_and_confirmation_before_sending_review() {
    use std::os::unix::fs::PermissionsExt;
    let runtime = tokio::runtime::Runtime::new().unwrap();
    for advertised in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let executable = dir.path().join("codex");
        let script = r#"#!/usr/bin/env python3
import sys,json,pathlib
args=sys.argv[1:]
if args == ['--version']:
    print('codex-cli 0.157.0'); sys.exit(0)
if 'generate-json-schema' in args:
    out=pathlib.Path(args[args.index('--out')+1])/'v2'
    out.mkdir(parents=True,exist_ok=True)
    schema={'definitions':{'SandboxMode':{'enum':['danger-full-access']}}}
    if ADVERTISED: schema['properties']={'ephemeral':{'type':['boolean','null']}}
    (out/'ThreadStartParams.json').write_text(json.dumps(schema))
    sys.exit(0)
pathlib.Path('started').touch()
for line in sys.stdin:
    value=json.loads(line)
    if value.get('method')=='initialize': print(json.dumps({'id':1,'result':{}}),flush=True)
    if value.get('method')=='thread/start':
        assert value['params']['ephemeral'] is True
        print(json.dumps({'id':2,'result':{'thread':{'id':'unconfirmed','ephemeral':False}}}),flush=True)
    if value.get('method')=='turn/start': pathlib.Path('review-sent').touch()
"#.replace("ADVERTISED", if advertised { "True" } else { "False" });
        fs::write(&executable, script).unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let config = ProviderConfig {
            provider: "codex".into(),
            executable: executable.to_string_lossy().into_owned(),
            model: None,
        };
        let mut stream = Stream {
            id: id(),
            sequence: 0,
            channel: Channel::new(|_| Ok(())),
            text: String::new(),
        };
        let error = runtime
            .block_on(codex::run(
                dir.path(),
                "private review context",
                &config,
                Arc::new(AtomicBool::new(false)),
                &mut stream,
            ))
            .unwrap_err();
        assert_eq!(error.code, "incompatible_provider");
        assert!(error.message.contains("ephemeral"));
        assert_eq!(dir.path().join("started").exists(), advertised);
        assert!(!dir.path().join("review-sent").exists());
    }
}

#[cfg(unix)]
#[test]
fn claude_disables_session_persistence_and_receives_reconstructed_context() {
    use std::os::unix::fs::PermissionsExt;
    let (directory, storage, _repository, _workspace, mut request) = fixture();
    request.provider = "claude".into();
    request.action = "ask".into();
    request.request = "Initial Claude question".into();
    let executable = directory.path().join("claude");
    fs::write(
        &executable,
        r#"#!/usr/bin/env python3
import sys,json,pathlib
args=sys.argv[1:]
assert '--no-session-persistence' in args
assert '-p' in args
assert '--resume' not in args and '--continue' not in args
prompt=sys.stdin.read()
pointer=next(line for line in prompt.splitlines() if line.strip().startswith('"reviewManifest":'))
root=pathlib.Path(json.loads(pointer.split(':',1)[1].strip().rstrip(','))).parent
history=json.loads((root/'conversation.json').read_text())
if 'Follow up Claude' in prompt:
    assert '--model' not in args and '--effort' not in args
    assert len(history['exchanges'])==1
    previous=json.loads(pathlib.Path(history['exchanges'][0]['exchangeFile']).read_text())
    assert previous['request']=='Initial Claude question'
    assert previous['answer']=='Remembered answer'
else:
    assert history['exchanges']==[]
    assert args[args.index('--model')+1]=='claude-sonnet-5'
    assert args[args.index('--effort')+1]=='medium'
print(json.dumps({'type':'result','is_error':False,'result':'Remembered answer'}),flush=True)
"#,
    )
    .unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let mut configuration = settings(&storage).unwrap();
    configuration
        .providers
        .iter_mut()
        .find(|p| p.provider == "claude")
        .unwrap()
        .executable = executable.to_string_lossy().into_owned();
    configure(&storage, configuration).unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    for question in ["Initial Claude question", "Follow up Claude"] {
        if question == "Follow up Claude" {
            let mut configuration = settings(&storage).unwrap();
            configuration
                .providers
                .iter_mut()
                .find(|p| p.provider == "claude")
                .unwrap()
                .model = None;
            configure(&storage, configuration).unwrap();
        }
        request.id = id();
        request.request = question.into();
        let result = runtime
            .block_on(run(
                storage.clone(),
                resources(),
                request.clone(),
                Arc::new(AtomicBool::new(false)),
                Channel::new(|_| Ok(())),
            ))
            .unwrap();
        assert_eq!(result.status, "completed");
    }
    assert_eq!(storage.list::<AgentRun>("agent_run").unwrap().len(), 2);
}

#[cfg(unix)]
#[test]
fn codex_runs_in_project_with_tools_and_keeps_only_the_final_answer() {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
    use std::os::unix::fs::PermissionsExt;
    let (directory, storage, repository, _workspace, mut request) = fixture();
    request.request = "Initial question".into();
    let executable = directory.path().join("codex-fixture");
    fs::write(&executable, r##"#!/usr/bin/env python3
import sys, json, pathlib
args = sys.argv[1:]
if args == ['--version']:
    print('codex-cli 0.157.0'); sys.exit(0)
if 'generate-json-schema' in args:
    out = pathlib.Path(args[args.index('--out') + 1]) / 'v2'
    out.mkdir(parents=True, exist_ok=True)
    (out / 'ThreadStartParams.json').write_text(json.dumps({'properties':{'ephemeral':{'type':['boolean','null']}},'definitions':{'SandboxMode':{'enum':['danger-full-access']}}}))
    sys.exit(0)
assert args == ['app-server','--listen','stdio://'], args

def send(value):
    print(json.dumps(value), flush=True)
for line in sys.stdin:
    value = json.loads(line)
    method = value.get('method')
    if method == 'initialize': send({'id':1,'result':{}})
    elif method == 'thread/start':
        params = value['params']
        assert params['cwd'] == str(pathlib.Path.cwd())
        assert params['approvalPolicy'] == 'never'
        assert params['sandbox'] == 'danger-full-access'
        assert params['ephemeral'] is True
        model = params['model']
        assert model in ['gpt-6-sol', None]
        assert 'config' not in params and 'permissions' not in params
        assert (pathlib.Path.cwd() / 'code.ts').read_text().endswith('3;\n')
        send({'id':2,'result':{'thread':{'id':'review-thread','ephemeral':True}}})
    elif method == 'turn/start':
        assert value['params']['sandboxPolicy'] == {'type':'dangerFullAccess'}
        assert value['params'].get('effort') == ('medium' if model else None)
        text = value['params']['input'][0]['text']
        pointer = next(line for line in text.splitlines() if line.strip().startswith('"reviewManifest":'))
        manifest = json.loads(pathlib.Path(json.loads(pointer.split(':',1)[1].strip().rstrip(','))).read_text())
        history = json.loads((pathlib.Path(json.loads(pointer.split(':',1)[1].strip().rstrip(','))).parent / 'conversation.json').read_text())
        if 'Follow up on our earlier answer' in text:
            assert len(history['exchanges']) == 1
            previous = json.loads(pathlib.Path(history['exchanges'][0]['exchangeFile']).read_text())
            assert previous['request'] == 'Initial question'
            assert json.loads(previous['answer']) == {'kind':'topics','topics':[]}
        else:
            assert history['exchanges'] == []
        change = next(item for item in manifest['changes'] if item['layer'] == 'staged')
        metadata = json.loads(pathlib.Path(change['metadata']).read_text())
        assert pathlib.Path(metadata['after']['path']).read_text().endswith('2;\n')
        send({'id':3,'result':{}})
        send({'method':'item/started','params':{'item':{'type':'commandExecution','id':'tool'}}})
        send({'method':'item/commandExecution/requestApproval','id':99,'params':{}})
    elif value.get('id') == 99:
        assert value['result']['decision'] == 'accept'
        send({'method':'item/agentMessage/delta','params':{'itemId':'comment','delta':'I will inspect more files.'}})
        send({'method':'item/completed','params':{'item':{'type':'agentMessage','id':'comment','phase':'commentary','text':'I will inspect more files.'}}})
        send({'method':'item/started','params':{'item':{'type':'contextCompaction','id':'compact'}}})
        send({'method':'item/completed','params':{'item':{'type':'agentMessage','id':'answer','phase':'final_answer','text':'{"kind":"topics","topics":[]}'}}})
        send({'method':'turn/completed','params':{'turn':{'status':'completed'}}})
"##).unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let mut configuration = settings(&storage).unwrap();
    configuration
        .providers
        .iter_mut()
        .find(|p| p.provider == "codex")
        .unwrap()
        .executable = executable.to_string_lossy().into_owned();
    configure(&storage, configuration).unwrap();
    let events = Arc::new(Mutex::new(Vec::<AgentEvent>::new()));
    let received = events.clone();
    let channel = Channel::new(move |body| {
        let tauri::ipc::InvokeResponseBody::Json(text) = body else {
            panic!("expected JSON");
        };
        received
            .lock()
            .unwrap()
            .push(serde_json::from_str(&text).unwrap());
        Ok(())
    });
    let path = manifest(&prepare(&storage, &resources(), &request).unwrap());
    let result = run(
        storage.clone(),
        resources(),
        request.clone(),
        Arc::new(AtomicBool::new(false)),
        channel,
    )
    .await
    .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&result.output).unwrap(),
        json!({"kind":"topics","topics":[]})
    );
    assert!(!result.output.contains("inspect"));
    assert!(
        events
            .lock()
            .unwrap()
            .iter()
            .any(|e| e.text.contains("compacting"))
    );
    assert!(events.lock().unwrap().iter().any(|e| e.kind == "completed"));
    assert!(!path.exists());
    assert!(!Path::new(&repository.path).join("protocol").exists());
    request.id = id();
    request.action = "ask".into();
    request.request = "Follow up on our earlier answer".into();
    let mut configuration = settings(&storage).unwrap();
    configuration.providers.iter_mut().find(|p| p.provider == "codex").unwrap().model = None;
    configure(&storage, configuration).unwrap();
    let second = run(storage.clone(), resources(), request, Arc::new(AtomicBool::new(false)), Channel::new(|_| Ok(()))).await.unwrap();
    assert_eq!(second.status, "completed");
    assert_eq!(storage.list::<AgentRun>("agent_run").unwrap().len(), 2);
    assert!(second.prompt.text.contains("Initial question"));
    });
}
