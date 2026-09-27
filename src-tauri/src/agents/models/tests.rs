use super::*;

#[test]
fn model_precedence_respects_the_project_harness_and_explicit_inheritance() {
    let config = ProviderConfig {
        provider: "codex".into(),
        executable: "codex".into(),
        model: Some("application-model".into()),
    };
    let mut project = ProjectSettings::default();
    assert_eq!(
        for_project(config.clone(), project.clone()).model,
        config.model
    );
    project.model = Some("project-model".into());
    project.provider = Some("codex".into());
    assert_eq!(
        for_project(config.clone(), project.clone()).model,
        project.model
    );
    project.provider = Some("claude".into());
    assert_eq!(for_project(config.clone(), project).model, config.model);
    let mut inherited = config;
    inherited.model = None;
    assert!(
        for_project(inherited, ProjectSettings::default())
            .model
            .is_none()
    );
}

#[test]
fn defaults_migrate_once_and_preserve_explicit_choices() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("data")).unwrap();
    let initial = settings(&storage).unwrap();
    assert_eq!(initial.providers[0].model.as_deref(), Some("gpt-6-sol"));
    assert_eq!(
        initial.providers[1].model.as_deref(),
        Some("claude-sonnet-5")
    );
    storage
        .insert(
            "providers",
            "settings",
            &json!({
                "revision":0,"defaultProvider":"claude","providers":[
                    {"provider":"codex","executable":"codex","model":null},
                    {"provider":"claude","executable":"claude","model":"custom-model"}
                ]
            }),
        )
        .unwrap();
    let mut migrated = settings(&storage).unwrap();
    assert_eq!(migrated.model_defaults_version, 1);
    assert_eq!(migrated.default_provider, "claude");
    assert_eq!(migrated.providers[0].model.as_deref(), Some("gpt-6-sol"));
    assert_eq!(migrated.providers[1].model.as_deref(), Some("custom-model"));
    let revision = migrated.revision;
    assert_eq!(settings(&storage).unwrap().revision, revision);
    migrated.providers[0].model = None;
    configure(&storage, migrated).unwrap();
    drop(storage);
    let reopened = Storage::open(directory.path().join("data")).unwrap();
    assert!(settings(&reopened).unwrap().providers[0].model.is_none());
    assert!(!directory.path().join(".reviewbox").exists());
}

#[test]
fn parsing_preserves_aliases_variants_and_rejects_malformed_catalogs() {
    let models = parse(&json!([
        {"value":"sonnet","resolvedModel":"claude-sonnet-5","displayName":"Sonnet","supportsEffort":true,"supportedEffortLevels":["medium"]},
        {"value":"sonnet[1m]","resolvedModel":"claude-sonnet-5","displayName":"Sonnet 1M"}
    ]), "claude").unwrap();
    assert_eq!(models.len(), 2);
    assert_eq!(models[1].id, "sonnet[1m]");
    assert_eq!(models[0].resolved_model.as_deref(), Some("claude-sonnet-5"));
    assert!(models[1].supported_efforts.is_empty());
    assert!(parse(&json!([]), "claude").unwrap().is_empty());
    assert!(parse(&json!({}), "claude").is_err());
    assert!(parse(&json!([{"value":"test"}]), "claude").is_err());
}

#[cfg(unix)]
fn fixture(provider: &str, mode: &str) -> (tempfile::TempDir, ProviderConfig) {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap();
    let executable = directory.path().join("harness");
    let script = r#"#!/usr/bin/env python3
import sys,json,pathlib,time,subprocess,os
provider=PROVIDER
mode=MODE
args=sys.argv[1:]
root=pathlib.Path(__file__).parent
if provider=='claude':
    assert '--safe-mode' in args and '--no-session-persistence' in args
    assert '--strict-mcp-config' in args and '--mcp-config' in args
else:
    assert args[:3]==['app-server','--listen','stdio://']
    assert 'mcp_servers={}' in args
if mode=='slow':
    child=subprocess.Popen(['sleep','60'])
    (root/'pids').write_text(str(os.getpid())+' '+str(child.pid))
    time.sleep(60)
    sys.exit(1)
def send(value): print(json.dumps(value),flush=True)
for line in sys.stdin:
    value=json.loads(line)
    if provider=='claude':
        assert value['request']['subtype']=='initialize'
        assert value['type']=='control_request'
        models=[] if mode=='empty' else [{'value':'sonnet','resolvedModel':'claude-sonnet-5','displayName':'Sonnet','description':'Efficient','supportsEffort':True,'supportedEffortLevels':['medium','high']},{'value':'haiku','displayName':'Haiku'}]
        send({'type':'control_response','response':{'request_id':value['request_id'],'subtype':'error' if mode=='error' else 'success','response':{'models':models,'account':{'secret':'never-exposed'}}}})
    else:
        assert value['method'] in ['initialize','initialized','model/list'],value
        if value['method']=='initialize': send({'id':value['id'],'result':{}})
        if value['method']!='model/list': continue
        if mode=='error':
            send({'id':value['id'],'error':{'message':'private-internal-error'}})
            continue
        cursor=value['params'].get('cursor')
        assert not value['params']['includeHidden']
        models=[{'model':'gpt-6-sol' if cursor is None else 'gpt-6-luna','displayName':'Test model','supportedReasoningEfforts':[{'reasoningEffort':'medium'}]},{'model':'hidden','hidden':True,'displayName':'Hidden'}]
        send({'id':value['id'],'result':{'data':[] if mode=='empty' else models,'nextCursor':None if cursor or mode=='empty' else 'page-two'}})
"#.replace("PROVIDER", &serde_json::to_string(provider).unwrap()).replace("MODE", &serde_json::to_string(mode).unwrap());
    std::fs::write(&executable, script).unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let config = ProviderConfig {
        provider: provider.into(),
        executable: executable.to_string_lossy().into_owned(),
        model: None,
    };
    (directory, config)
}

#[cfg(unix)]
#[test]
fn discovery_paginates_and_filters_without_starting_a_turn() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    for provider in ["codex", "claude"] {
        let (_directory, mut config) = fixture(provider, "normal");
        let models = runtime
            .block_on(discover(&config, Arc::new(AtomicBool::new(false))))
            .unwrap();
        assert_eq!(models.len(), 2);
        assert!(models[0].supported_efforts.contains(&"medium".into()));
        assert!(
            !serde_json::to_string(&models)
                .unwrap()
                .contains("never-exposed")
        );
        assert!(
            runtime
                .block_on(effort(&config, Arc::new(AtomicBool::new(false))))
                .unwrap()
                .is_none()
        );
        config.model = Some(
            if provider == "codex" {
                "gpt-6-luna"
            } else {
                "sonnet"
            }
            .into(),
        );
        assert_eq!(
            runtime
                .block_on(effort(&config, Arc::new(AtomicBool::new(false))))
                .unwrap(),
            Some("medium")
        );
        config.model = Some("unlisted".into());
        assert!(
            runtime
                .block_on(effort(&config, Arc::new(AtomicBool::new(false))))
                .unwrap()
                .is_none()
        );
    }
}

#[cfg(unix)]
#[test]
fn empty_catalogs_and_provider_errors_are_not_invented_models() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    for provider in ["codex", "claude"] {
        let (_directory, config) = fixture(provider, "empty");
        assert!(
            runtime
                .block_on(discover(&config, Arc::new(AtomicBool::new(false))))
                .unwrap()
                .is_empty()
        );
        let (_directory, config) = fixture(provider, "error");
        let error = runtime
            .block_on(discover(&config, Arc::new(AtomicBool::new(false))))
            .unwrap_err();
        assert_eq!(error.code, "model_catalog");
        assert!(!error.message.contains("private-internal"));
    }
}

#[cfg(unix)]
#[test]
fn timeout_and_cancellation_terminate_process_groups() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    for cancelled in [false, true] {
        let (directory, config) = fixture("claude", "slow");
        runtime.block_on(async {
            let cancel = Arc::new(AtomicBool::new(false));
            let operation =
                discover_with_timeout(&config, cancel.clone(), Duration::from_millis(900));
            let signal = cancel.clone();
            let interrupter = tokio::spawn(async move {
                if cancelled {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    signal.store(true, Ordering::Relaxed);
                }
            });
            let result = operation.await;
            interrupter.await.unwrap();
            assert_eq!(
                result.unwrap_err().code,
                if cancelled {
                    "cancelled"
                } else {
                    "model_catalog_timeout"
                }
            );
        });
        let pids = std::fs::read_to_string(directory.path().join("pids")).unwrap();
        for pid in pids.split_whitespace() {
            let output = std::process::Command::new("ps")
                .args(["-o", "stat=", "-p", pid])
                .output()
                .unwrap();
            let state = String::from_utf8_lossy(&output.stdout);
            assert!(
                state.trim().is_empty() || state.trim().starts_with('Z'),
                "process {pid} is still running"
            );
        }
    }
}

#[test]
#[ignore = "Reads the installed harness catalogs with the user's authentication, without a model turn"]
fn installed_harness_catalogs() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    for provider in ["codex", "claude"] {
        let config = ProviderConfig {
            provider: provider.into(),
            executable: provider.into(),
            model: None,
        };
        let models = runtime
            .block_on(discover(&config, Arc::new(AtomicBool::new(false))))
            .unwrap();
        let expected = default_model(provider).unwrap();
        assert!(models.iter().any(|m| (m.id == expected
            || m.resolved_model.as_deref() == Some(expected))
            && m.supported_efforts.contains(&"medium".into())));
        println!(
            "{provider}: {} models; configured default supports medium",
            models.len()
        );
    }
}
