use super::*;
use serde_json::json;
use std::{fs, path::Path, process::Command, time::Duration};

/// Opt-in installer smoke tests use real captured bytes and actual feature
/// requests, so an initialize handshake alone cannot mask an unusable server.
pub(super) async fn probe_server(
    server: LanguageServerConfig,
    environment: Vec<(String, String)>,
    storage: Storage,
) -> AppResult<LanguageCapabilities> {
    let (path, text, line, column) = match server.id.as_str() {
        "slang" => (
            "main.hlsl",
            "float4 tint(float4 color) { return color; }\nfloat4 main() : SV_Target { return tint(float4(1,0,0,1)); }\n",
            2,
            36,
        ),
        "typescript" => (
            "main.ts",
            "const value: number = 42;\nexport const answer = value;\n",
            2,
            23,
        ),
        "vue" => (
            "App.vue",
            "<script setup lang=\"ts\">\nconst value = 42;\n</script>\n<template><p>{{ value }}</p></template>\n",
            2,
            7,
        ),
        "svelte" => (
            "App.svelte",
            "<script lang=\"ts\">\nconst value = 42;\n</script>\n<p>{value}</p>\n",
            2,
            7,
        ),
        "python" => (
            "main.py",
            "def answer(value: int) -> int:\n    return value + 1\n\nresult = answer(41)\n",
            4,
            10,
        ),
        "html" => (
            "index.html",
            "<!doctype html>\n<html><body><h1 id=\"answer\">Hello</h1></body></html>\n",
            2,
            16,
        ),
        "css" => ("style.css", ".answer {\n  color: red;\n}\n", 2, 4),
        "json" => ("data.json", "{\n  \"answer\": 42\n}\n", 2, 5),
        "yaml" => ("data.yaml", "answer: 42\nname: fixture\n", 1, 2),
        "bash" => (
            "main.sh",
            "#!/bin/sh\nanswer() {\n  printf '%s\\n' 42\n}\nanswer\n",
            5,
            2,
        ),
        "docker" => ("Dockerfile", "FROM scratch\nLABEL answer=\"42\"\n", 1, 2),
        "prisma" => (
            "schema.prisma",
            "model User {\n  id Int @id\n  name String\n}\n",
            1,
            8,
        ),
        "rust" => (
            "main.rs",
            "fn answer(value: i32) -> i32 { value + 1 }\nfn main() { let result = answer(41); }\n",
            2,
            27,
        ),
        "go" => (
            "main.go",
            "package main\nfunc answer(value int) int { return value + 1 }\nfunc main() { _ = answer(41) }\n",
            3,
            20,
        ),
        "clangd" => (
            "main.cpp",
            "int answer(int value) { return value + 1; }\nint main() { return answer(41); }\n",
            2,
            23,
        ),
        "toml" => (
            "config.toml",
            "[package]\nname = \"fixture\"\nversion = \"1.0.0\"\n",
            2,
            2,
        ),
        "lua" => (
            "main.lua",
            "local function answer(value)\n  return value + 1\nend\nlocal result = answer(41)\n",
            4,
            18,
        ),
        "java" => (
            "Main.java",
            "public class Main {\n  public static int answer(int value) { return value + 1; }\n  public static void main(String[] args) { answer(41); }\n}\n",
            3,
            44,
        ),
        "kotlin" => (
            "Main.kt",
            "fun answer(value: Int): Int = value + 1\nfun main() { println(answer(41)) }\n",
            2,
            24,
        ),
        "csharp" => (
            "Main.cs",
            "class Program {\n  static int Answer(int value) { return value + 1; }\n  static void Main() { Answer(41); }\n}\n",
            3,
            24,
        ),
        "swift" => (
            "main.swift",
            "func answer(_ value: Int) -> Int { value + 1 }\nlet result = answer(41)\n",
            2,
            16,
        ),
        "ruby" => (
            "main.rb",
            "def answer(value)\n  value + 1\nend\nresult = answer(41)\n",
            4,
            12,
        ),
        "sql" => (
            "main.sql",
            "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);\nSELECT name FROM users;\n",
            2,
            9,
        ),
        other => {
            return Err(AppError::new(
                "language_probe",
                format!("Missing fixture for {other}"),
            ));
        }
    };
    let blob = storage.blob(text.as_bytes(), "100644".into())?;
    let document = LanguageDocument {
        snapshot_id: "language-feature-smoke".into(),
        path: path.into(),
        change_id: None,
        side: None,
        content_hash: blob.hash.clone(),
    };
    let mut files = std::collections::BTreeMap::from([(path.into(), blob)]);
    let manifest = match server.id.as_str() {
        "rust" => Some((
            "Cargo.toml",
            "[package]\nname = \"fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n[[bin]]\nname = \"fixture\"\npath = \"main.rs\"\n",
        )),
        "go" => Some(("go.mod", "module example.invalid/fixture\n\ngo 1.24\n")),
        _ => None,
    };
    if let Some((path, text)) = manifest {
        files.insert(path.into(), storage.blob(text.as_bytes(), "100644".into())?);
    }
    if server.id == "rust" {
        files.insert(
            "build.rs".into(),
            storage.blob(
                b"fn main() { std::fs::write(\"build-ran\", b\"unexpected\").unwrap(); }",
                "100644".into(),
            )?,
        );
    }
    if server.id == "swift" {
        files.insert("Package.swift".into(), storage.blob(b"// swift-tools-version: 5.9\nimport PackageDescription\nimport Foundation\ntry! Data(\"unexpected\".utf8).write(to: URL(fileURLWithPath: \"build-ran\"))\nlet package = Package(name: \"Fixture\", targets: [.executableTarget(name: \"Fixture\", path: \".\")])\n", "100644".into())?);
    }
    let tree = workspace::SourceTree {
        snapshot_id: document.snapshot_id.clone(),
        key: server.id.clone(),
        files,
        change_id: None,
        side: None,
    };
    let workspace = workspace::Workspace::create(&storage, tree)?;
    let session = session::Session::spawn(server, workspace, environment)?;
    let outcome = async {
        session.initialize().await?;
        let mut exercised = 0;
        for method in [
            LanguageMethod::Symbols,
            LanguageMethod::SemanticTokens,
            LanguageMethod::Hover,
            LanguageMethod::Definitions,
            LanguageMethod::References,
        ] {
            let capabilities = session.capabilities();
            let enabled = match method {
                LanguageMethod::Symbols => capabilities.symbols,
                LanguageMethod::SemanticTokens => true,
                LanguageMethod::Hover => capabilities.hover,
                LanguageMethod::Definitions => capabilities.definitions,
                LanguageMethod::References => capabilities.references,
            };
            if !enabled {
                continue;
            }
            let request = LanguageRequest {
                request_id: format!("probe-{method:?}"),
                document: document.clone(),
                method,
                line: Some(line),
                column: Some(column),
            };
            let mut response = match session.request(&request, &AtomicBool::new(false)).await {
                Err(error) if error.code == "unsupported_capability" => continue,
                other => other?,
            };
            if session.server.id == "rust" && method == LanguageMethod::Hover {
                // rust-analyzer indexes Cargo asynchronously after initialize.
                for _ in 0..20 {
                    if response
                        .hover
                        .as_ref()
                        .is_some_and(|hover| !hover.markdown.is_empty())
                    {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    response = session.request(&request, &AtomicBool::new(false)).await?;
                }
            }
            eprintln!(
                "Feature {} {method:?}: symbols={}, tokens={}, hover={}, locations={}",
                session.server.id,
                response.symbols.len(),
                response
                    .tokens
                    .as_ref()
                    .map_or(0, |tokens| tokens.data.len() / 5),
                response
                    .hover
                    .as_ref()
                    .is_some_and(|hover| !hover.markdown.is_empty()),
                response.locations.len()
            );
            exercised += 1;
        }
        if exercised == 0 {
            return Err(AppError::new(
                "language_probe",
                "No supported feature was exercised.",
            ));
        }
        if session.workspace.root().join("build-ran").exists() {
            return Err(AppError::new(
                "language_probe",
                "The language server executed a project build script.",
            ));
        }
        Ok(session.capabilities())
    }
    .await;
    session.stop();
    outcome
}

fn git(root: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
fn fixture() -> (tempfile::TempDir, Storage, Snapshot) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("repo");
    fs::create_dir(&root).unwrap();
    git(&root, &["init", "-q"]);
    git(&root, &["config", "user.name", "Fixture"]);
    git(&root, &["config", "user.email", "fixture@example.invalid"]);
    fs::write(root.join("main.ts"), "const value = 1;\n").unwrap();
    fs::write(root.join("helper.ts"), "export const helper = 1;\n").unwrap();
    fs::write(root.join("old.ts"), "export const old = 1;\n").unwrap();
    git(&root, &["add", "."]);
    git(&root, &["commit", "-qm", "base"]);
    fs::write(root.join("main.ts"), "const value = 2;\n").unwrap();
    fs::write(root.join("helper.ts"), "export const helper = 2;\n").unwrap();
    git(&root, &["mv", "old.ts", "renamed.ts"]);
    git(&root, &["add", "."]);
    fs::write(root.join("main.ts"), "const value = 3;\n").unwrap();
    fs::write(root.join("helper.ts"), "export const helper = 3;\n").unwrap();
    let storage = Storage::open(directory.path().join("app")).unwrap();
    let repository = crate::repositories::open(&storage, root.to_str().unwrap()).unwrap();
    let snapshot = crate::snapshots::capture(
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
    (directory, storage, snapshot)
}
fn document(snapshot: &Snapshot, layer: &str, side: LanguageSide) -> LanguageDocument {
    let change = snapshot
        .changes
        .iter()
        .find(|change| change.path == "main.ts" && change.layer == layer)
        .unwrap();
    LanguageDocument {
        snapshot_id: snapshot.id.clone(),
        path: change.path.clone(),
        change_id: Some(change.id.clone()),
        side: Some(side),
        content_hash: match side {
            LanguageSide::Before => change.before.as_ref(),
            LanguageSide::After => change.after.as_ref(),
        }
        .unwrap()
        .hash
        .clone(),
    }
}

#[test]
fn captured_trees_keep_all_files_in_the_selected_layer() {
    let (_directory, storage, snapshot) = fixture();
    for (layer, side, expected, old_present) in [
        ("staged", LanguageSide::Before, "1", true),
        ("staged", LanguageSide::After, "2", false),
        ("unstaged", LanguageSide::Before, "2", false),
        ("unstaged", LanguageSide::After, "3", false),
    ] {
        let doc = document(&snapshot, layer, side);
        let tree = workspace::source_tree(&snapshot, &doc).unwrap();
        assert_eq!(tree.files.contains_key("old.ts"), old_present);
        assert_eq!(tree.files.contains_key("renamed.ts"), !old_present);
        let helper =
            String::from_utf8(storage.read_blob(&tree.files["helper.ts"].hash).unwrap()).unwrap();
        assert_eq!(helper, format!("export const helper = {expected};\n"));
        let work = workspace::Workspace::create(&storage, tree).unwrap();
        let location = work
            .location(
                work.uri("helper.ts").unwrap().as_str(),
                &json!({"start":{"line":0,"character":13},"end":{"line":0,"character":19}}),
            )
            .unwrap();
        assert_eq!(read_source(&storage, &location.document).unwrap(), helper);
    }
}

#[test]
fn stale_hashes_and_live_edits_never_change_captured_sources() {
    let (directory, storage, snapshot) = fixture();
    let mut doc = document(&snapshot, "staged", LanguageSide::Before);
    fs::write(directory.path().join("repo/main.ts"), "wrong live source").unwrap();
    assert_eq!(read_source(&storage, &doc).unwrap(), "const value = 1;\n");
    doc.content_hash = "wrong".into();
    assert_eq!(
        read_source(&storage, &doc).unwrap_err().code,
        "stale_language_document"
    );
}

#[test]
fn unicode_positions_and_semantic_tokens_are_checked() {
    let source = "😀value\r\n";
    assert!(workspace::validate_position(source, 1, 2).is_err());
    assert!(workspace::validate_position(source, 1, 3).is_ok());
    let legend = json!({"tokenTypes":["variable"],"tokenModifiers":["readonly"]});
    assert!(session::tokens(source, &json!({"data":[0,2,5,0,1]}), &legend).is_ok());
    assert!(session::tokens(source, &json!({"data":[0,1,5,0,0]}), &legend).is_err());
    assert!(session::tokens(source, &json!({"data":[0,2,5,1,0]}), &legend).is_err());
    assert!(session::tokens(source, &json!({"data":[0,2,5,0,2]}), &legend).is_err());
    assert!(session::tokens(source, &json!({"data":[0,2,5,0,0,0,1,1,0,0]}), &legend).is_err());
}

#[cfg(unix)]
const SERVER: &str = r#"
import sys,json,os,time,threading
from pathlib import Path
from urllib.parse import urlparse,unquote
marker=Path(sys.argv[1]); lock=threading.Lock(); root=None; dynamic=len(sys.argv)>2
legend={'full':True,'legend':{'tokenTypes':['variable'],'tokenModifiers':['readonly']}}
with marker.open('a') as f: f.write('start\n')
def send(value):
    data=json.dumps(value).encode()
    with lock:
        sys.stdout.buffer.write(('Content-Length: %d\r\n\r\n'%len(data)).encode()+data);sys.stdout.buffer.flush()
def reply(id,result): send({'jsonrpc':'2.0','id':id,'result':result})
def late(id):
    time.sleep(.2);reply(id,{'contents':{'kind':'markdown','value':'late reply'}})
while True:
    length=None
    while True:
        line=sys.stdin.buffer.readline()
        if not line: sys.exit(0)
        if line in (b'\n',b'\r\n'): break
        if line.lower().startswith(b'content-length:'): length=int(line.split(b':',1)[1])
    value=json.loads(sys.stdin.buffer.read(length));method=value.get('method');id=value.get('id')
    with marker.open('a') as f: f.write(str(method)+'\n')
    if method=='initialize':
        root=value['params']['rootUri']
        reply(id,{'capabilities':{'positionEncoding':'utf-16','hoverProvider':True,'definitionProvider':True,'referencesProvider':True,'documentSymbolProvider':True,'semanticTokensProvider':None if dynamic else legend}})
    elif method=='textDocument/didOpen' and dynamic:
        registration={'jsonrpc':'2.0','id':'register','method':'client/registerCapability','params':{'registrations':[{'id':'tokens','method':'textDocument/semanticTokens','registerOptions':legend}]}}
        send(registration);send(registration)
    elif method=='textDocument/semanticTokens/full':
        send({'jsonrpc':'2.0','method':'window/logMessage','params':{'type':3,'message':'noise'}})
        reply(id,{'data':[0,6,5,0,1]})
    elif method=='textDocument/hover':
        if value['params']['position']['character']==1: threading.Thread(target=late,args=(id,),daemon=True).start()
        else: reply(id,{'contents':{'kind':'markdown','value':'Captured **value**'},'range':{'start':{'line':0,'character':6},'end':{'line':0,'character':11}}})
    elif method in ('textDocument/definition','textDocument/references'):
        reply(id,[{'uri':root+'/helper.ts','range':{'start':{'line':0,'character':13},'end':{'line':0,'character':19}}},{'uri':'file:///outside.ts','range':{'start':{'line':0,'character':0},'end':{'line':0,'character':1}}}])
    elif method=='textDocument/documentSymbol':
        reply(id,[{'name':'value','kind':14,'range':{'start':{'line':0,'character':0},'end':{'line':0,'character':16}},'selectionRange':{'start':{'line':0,'character':6},'end':{'line':0,'character':11}}}])
"#;

#[cfg(unix)]
fn server_config(marker: &Path) -> LanguageServerConfig {
    LanguageServerConfig {
        id: "fixture".into(),
        name: "Protocol fixture".into(),
        extensions: vec!["ts".into()],
        executable: "python3".into(),
        arguments: vec![
            "-u".into(),
            "-c".into(),
            SERVER.into(),
            marker.to_string_lossy().into(),
        ],
    }
}

#[cfg(unix)]
#[test]
fn persistent_protocol_handles_features_cancel_and_interleaved_notifications() {
    let (directory, storage, snapshot) = fixture();
    let marker = directory.path().join("protocol.log");
    configure(
        &storage,
        LanguageServerSettings {
            servers: vec![server_config(&marker)],
            revision: 0,
        },
    )
    .unwrap();
    let manager = LanguageServers::default();
    tauri::async_runtime::block_on(async {
        let base = LanguageRequest {
            request_id: "tokens".into(),
            document: document(&snapshot, "staged", LanguageSide::After),
            method: LanguageMethod::SemanticTokens,
            line: Some(1),
            column: Some(7),
        };
        let first = manager
            .request(storage.clone(), base.clone())
            .await
            .unwrap();
        assert_eq!(first.tokens.unwrap().data, vec![0, 6, 5, 0, 1]);
        for method in [
            LanguageMethod::Hover,
            LanguageMethod::Definitions,
            LanguageMethod::References,
            LanguageMethod::Symbols,
        ] {
            let mut req = base.clone();
            req.method = method;
            req.request_id = format!("{method:?}");
            let result = manager.request(storage.clone(), req).await.unwrap();
            match method {
                LanguageMethod::Hover => {
                    assert!(result.hover.unwrap().markdown.contains("Captured"))
                }
                LanguageMethod::Definitions | LanguageMethod::References => {
                    assert_eq!(result.locations.len(), 1);
                    assert_eq!(
                        read_source(&storage, &result.locations[0].document).unwrap(),
                        "export const helper = 2;\n"
                    );
                }
                LanguageMethod::Symbols => assert_eq!(result.symbols[0].name, "value"),
                _ => unreachable!(),
            }
        }
        assert_eq!(
            fs::read_to_string(&marker)
                .unwrap()
                .lines()
                .filter(|line| *line == "start")
                .count(),
            1
        );
        let mut slow = base.clone();
        slow.request_id = "cancel-me".into();
        slow.method = LanguageMethod::Hover;
        slow.column = Some(2);
        let other = manager.clone();
        let copy = storage.clone();
        let task = tauri::async_runtime::spawn(async move { other.request(copy, slow).await });
        for _ in 0..100 {
            if fs::read_to_string(&marker)
                .unwrap()
                .lines()
                .filter(|line| *line == "textDocument/hover")
                .count()
                >= 2
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        manager.cancel("cancel-me");
        assert_eq!(task.await.unwrap().unwrap_err().code, "cancelled");
        // The late cancelled response must not fulfill the next request.
        tokio::time::sleep(Duration::from_millis(220)).await;
        let mut next = base;
        next.method = LanguageMethod::Hover;
        next.request_id = "next".into();
        assert_eq!(
            manager
                .request(storage.clone(), next)
                .await
                .unwrap()
                .hover
                .unwrap()
                .markdown,
            "Captured **value**"
        );
        manager.stop_server("fixture");
        assert!(manager.0.entries.lock().unwrap().is_empty());
        manager.stop_all();
    });
}

#[test]
fn bounded_sessions_evict_idle_entries_without_interrupting_active_requests() {
    let manager = LanguageServers::default();
    let active = (0..MAX_SESSIONS)
        .map(|index| {
            manager
                .entry(index.to_string(), "test".into(), "snapshot".into())
                .unwrap()
        })
        .collect::<Vec<_>>();
    assert!(
        manager
            .entry("overflow".into(), "test".into(), "snapshot".into())
            .is_err()
    );
    drop(active);
    let _next = manager
        .entry("next".into(), "test".into(), "snapshot".into())
        .unwrap();
    assert_eq!(manager.0.entries.lock().unwrap().len(), MAX_SESSIONS);
    manager.release_snapshot("snapshot");
    assert!(manager.0.entries.lock().unwrap().is_empty());
}

#[cfg(unix)]
#[test]
fn dynamic_semantic_registration_opens_document_and_notifies_once() {
    let (directory, storage, snapshot) = fixture();
    let mut config = server_config(&directory.path().join("dynamic.log"));
    config.arguments.push("dynamic".into());
    configure(
        &storage,
        LanguageServerSettings {
            servers: vec![config],
            revision: 0,
        },
    )
    .unwrap();
    let manager = LanguageServers::default();
    let notifications = Arc::new(AtomicU64::new(0));
    let counter = notifications.clone();
    manager.set_notifier(move || {
        counter.fetch_add(1, Ordering::Relaxed);
    });
    tauri::async_runtime::block_on(async {
        let response = manager
            .request(
                storage,
                LanguageRequest {
                    request_id: "dynamic".into(),
                    document: document(&snapshot, "staged", LanguageSide::After),
                    method: LanguageMethod::SemanticTokens,
                    line: None,
                    column: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(response.tokens.unwrap().data.len(), 5);
        assert_eq!(notifications.load(Ordering::Relaxed), 1);
    });
    manager.stop_all();
}
