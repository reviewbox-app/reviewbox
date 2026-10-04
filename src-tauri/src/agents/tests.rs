use super::*;
use crate::reviews;
use serde_json::json;
use std::{fs, path::Path, process::Command};

#[test]
#[cfg(unix)]
fn unexpected_provider_exit_keeps_bounded_stderr_and_exit_status() {
    tauri::async_runtime::block_on(async {
        let mut command = tokio::process::Command::new("/bin/sh");
        command.args([
            "-c",
            "printf 'HTTP 403; Bearer private-token\\n' >&2; exit 7",
        ]);
        let mut transport = Transport::new(command, Arc::new(AtomicBool::new(false))).unwrap();
        let error = transport.next().await.unwrap_err();
        transport.finish().await;
        assert_eq!(error.code, "provider_exited");
        let details = error.details.unwrap();
        assert!(details.contains("HTTP 403"));
        assert!(!details.contains("private-token"));
        assert!(details.contains("Process status:"));
    });
}

#[test]
fn claude_failure_retains_provider_details_only() {
    let error = claude::failure(
        &json!({"subtype":"error_max_turns", "errors":["maximum turns exceeded"], "result":"API_KEY=private-token", "request":{"prompt":"source-sentinel"}}),
    );
    let details = error.details.unwrap();
    assert!(details.contains("maximum turns exceeded"));
    assert!(!details.contains("private-token"));
    assert!(!details.contains("source-sentinel"));
}

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
    exploration::ExplorationRequest,
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
    let request = exploration::ExplorationRequest {
        id: id(),
        paths: vec![],
    };
    (directory, storage, repository, workspace, request)
}
fn manifest(
    storage: &Storage,
    workspace: &Workspace,
    request: &exploration::ExplorationRequest,
) -> PathBuf {
    let descriptor = exploration::descriptor(storage, workspace, request).unwrap();
    let value: Value = serde_json::from_str(&descriptor).unwrap();
    value["reviewManifest"].as_str().unwrap().into()
}

#[test]
fn large_review_is_discovered_on_demand_without_inline_source_or_a_repository_copy() {
    let (_directory, storage, repository, workspace, request) = fixture();
    let descriptor = exploration::descriptor(&storage, &workspace, &request).unwrap();
    assert!(descriptor.len() < 16000);
    assert!(!descriptor.contains("SENTINEL_NOT_IN_PROMPT"));
    let path = manifest(&storage, &workspace, &request);
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
    let path = manifest(&storage, &workspace, &request);
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
            preview: None,
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
fn claude_disables_session_persistence() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let executable = dir.path().join("claude");
    fs::write(
        &executable,
        r#"#!/usr/bin/env python3
import sys,json
assert '--no-session-persistence' in sys.argv
assert '--resume' not in sys.argv and '--continue' not in sys.argv
assert sys.stdin.read() == 'Captured source context'
print(json.dumps({'type':'result','is_error':False,'result':'Complete answer'}),flush=True)
"#,
    )
    .unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let config = ProviderConfig {
        provider: "claude".into(),
        executable: executable.to_string_lossy().into(),
        model: None,
    };
    let mut stream = Stream {
        id: id(),
        sequence: 0,
        channel: Channel::new(|_| Ok(())),
        text: String::new(),
        preview: None,
    };
    tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(claude::run(
            dir.path(),
            "Captured source context",
            &config,
            Arc::new(AtomicBool::new(false)),
            &mut stream,
        ))
        .unwrap();
    assert_eq!(stream.text, "Complete answer");
}

#[cfg(unix)]
#[test]
fn codex_runs_in_project_with_tools_and_keeps_only_the_final_answer() {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
    use std::os::unix::fs::PermissionsExt;
    let (directory, storage, repository, workspace, request) = fixture();
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
    if 'method' in value and 'params' in value:
        value['params'].update({'threadId':'review-thread','turnId':'turn'})
        if 'turn' in value['params']: value['params']['turn']['id']='turn'
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
        assert model in ['gpt-6.1-sol', None]
        assert 'config' not in params and 'permissions' not in params
        assert (pathlib.Path.cwd() / 'code.ts').read_text().endswith('3;\n')
        send({'id':2,'result':{'thread':{'id':'review-thread','ephemeral':True}}})
    elif method == 'turn/start':
        assert value['params']['sandboxPolicy'] == {'type':'dangerFullAccess'}
        assert value['params'].get('effort') == ('medium' if model else None)
        text = value['params']['input'][0]['text']
        pointer = next(line for line in text.splitlines() if line.strip().startswith('"reviewManifest":'))
        manifest = json.loads(pathlib.Path(json.loads(pointer.split(':',1)[1].strip().rstrip(','))).read_text())
        change = next(item for item in manifest['changes'] if item['layer'] == 'staged')
        metadata = json.loads(pathlib.Path(change['metadata']).read_text())
        assert pathlib.Path(metadata['after']['path']).read_text().endswith('2;\n')
        send({'id':3,'result':{'turn':{'id':'turn'}}})
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
    let path = manifest(&storage, &workspace, &request);
    let exploration = exploration::materialize(&storage, &workspace, &request, &AtomicBool::new(false)).unwrap();
    let mut stream = Stream {id:id(),sequence:0,channel,text:String::new(),preview:None};
    let config = settings(&storage).unwrap().providers.into_iter().find(|p| p.provider == "codex").unwrap();
    codex::run(&exploration.project, &exploration::descriptor(&storage, &workspace, &request).unwrap(), &config, Arc::new(AtomicBool::new(false)), &mut stream).await.unwrap();
    drop(exploration);
    assert_eq!(
        serde_json::from_str::<Value>(&stream.text).unwrap(),
        json!({"kind":"topics","topics":[]})
    );
    assert!(!stream.text.contains("inspect"));
    assert!(
        events
            .lock()
            .unwrap()
            .iter()
            .any(|e| e.text.contains("compacting"))
    );
    assert!(!path.exists());
    assert!(!Path::new(&repository.path).join("protocol").exists());
    });
}
