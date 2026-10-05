use super::*;
use std::{fs, path::Path, time::Duration};

const PEER: &str = r#"
import sys,json,threading,time
opened={}
def send(value):
    body=json.dumps(value).encode();sys.stdout.buffer.write(b'Content-Length: '+str(len(body)).encode()+b'\r\n\r\n'+body);sys.stdout.buffer.flush()
def reply(id,result):send({'jsonrpc':'2.0','id':id,'result':result})
def late(id):time.sleep(.15);reply(id,{'contents':'old response'})
while True:
    length=0
    while True:
        line=sys.stdin.buffer.readline()
        if not line:sys.exit(0)
        if line in (b'\r\n',b'\n'):break
        if line.lower().startswith(b'content-length:'):length=int(line.split(b':',1)[1])
    msg=json.loads(sys.stdin.buffer.read(length));method=msg.get('method');params=msg.get('params',{});id=msg.get('id')
    if method=='initialize':reply(id,{'capabilities':{'positionEncoding':'utf-16','textDocumentSync':{'openClose':True,'change':2,'save':{'includeText':True}},'completionProvider':{},'hoverProvider':True}})
    elif method=='textDocument/didOpen':opened[params['textDocument']['uri']]=params['textDocument']
    elif method=='textDocument/didChange':
        doc=opened[params['textDocument']['uri']];old=doc['text'];change=params['contentChanges'][0]
        assert change['range']['end']=={'line':old.count('\n'),'character':len(old.split('\n')[-1].encode('utf-16-le'))//2}
        doc['text']=change['text'];doc['version']=params['textDocument']['version']
    elif method=='textDocument/completion':reply(id,[{'label':opened[params['textDocument']['uri']]['text'],'kind':6}])
    elif method=='textDocument/hover':threading.Thread(target=late,args=(id,),daemon=True).start()
"#;
fn entry(root: &Path, executable: &str, args: Vec<String>) -> Arc<Entry> {
    let canonical = root.canonicalize().unwrap();
    let root = canonical.as_path();
    let server = LanguageServerConfig {
        id: "test".into(),
        name: "Live test".into(),
        extensions: vec![],
        executable: executable.into(),
        arguments: args,
    };
    let session = Session::spawn(server, Workspace::live(root.to_path_buf()), vec![]).unwrap();
    Arc::new(Entry {
        id: "test-session".into(),
        root: root.to_path_buf(),
        session,
        documents: AsyncMutex::new(BTreeMap::new()),
        storage: None,
        source_path: "main.ts".into(),
        configuration_paths: vec![],
        scope: root.to_path_buf(),
        context: LiveLanguageProjectContext {
            root_uri: url::Url::from_directory_path(root).unwrap().to_string(),
            configuration_files: vec![],
            environment: BTreeMap::new(),
            missing: vec![],
            signature: String::new(),
        },
    })
}
fn document(text: &str, version: i32) -> LiveLanguageDocument {
    LiveLanguageDocument {
        path: "main.ts".into(),
        version,
        text: text.into(),
        language_id: "typescript".into(),
        base_version: None,
        changes: vec![],
    }
}
#[test]
fn unsaved_sync_rejects_stale_versions_and_cancelled_responses_without_touching_disk() {
    tauri::async_runtime::block_on(async {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("main.ts"), "on disk").unwrap();
        let e = entry(
            temp.path(),
            "python3",
            vec!["-u".into(), "-c".into(), PEER.into()],
        );
        e.session.initialize().await.unwrap();
        synchronize(&e, document("😀 first\nend", 1), false)
            .await
            .unwrap();
        synchronize(&e, document("unsaved", 2), false)
            .await
            .unwrap();
        let value = query(
            &e,
            "completion",
            "main.ts",
            2,
            "textDocument/completion",
            json!({"position":{"line":0,"character":7}}),
        )
        .await
        .unwrap();
        assert_eq!(value[0]["label"], "unsaved");
        assert!(
            synchronize(&e, document("different", 2), false)
                .await
                .is_err()
        );
        let other = e.clone();
        let pending = tauri::async_runtime::spawn(async move {
            query(
                &other,
                "late",
                "main.ts",
                2,
                "textDocument/hover",
                json!({}),
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(40)).await;
        synchronize(&e, document("new version", 3), false)
            .await
            .unwrap();
        assert_eq!(pending.await.unwrap().unwrap_err().code, "stale_document");
        let other = e.clone();
        let pending = tauri::async_runtime::spawn(async move {
            query(
                &other,
                "cancelled",
                "main.ts",
                3,
                "textDocument/hover",
                json!({}),
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(40)).await;
        e.session.cancel("cancelled");
        assert_eq!(pending.await.unwrap().unwrap_err().code, "cancelled");
        assert_eq!(
            fs::read_to_string(temp.path().join("main.ts")).unwrap(),
            "on disk"
        );
        e.session.stop();
    });
}

#[test]
fn nested_project_roots_use_pack_data_and_stay_inside_checkout() {
    let temp = tempfile::tempdir().unwrap();
    let storage = Storage::open(temp.path().join("private")).unwrap();
    let root = temp.path().join("repo");
    fs::create_dir_all(root.join("packages/lib/src")).unwrap();
    fs::write(root.join("tsconfig.json"), "{}").unwrap();
    fs::write(root.join("packages/lib/package.json"), "{}").unwrap();
    let (project, _) =
        project_configuration(&storage, &root, "packages/lib/src/a.ts", "typescript").unwrap();
    assert_eq!(project, root.join("packages/lib"));
    assert!(project_configuration(&storage, &root, "../escape.ts", "typescript").is_err());
}

#[test]
fn incremental_edits_validate_utf16_and_recover_missing_versions() {
    let old = document("😀 hello\nworld", 7);
    let mut next = document("😀 hi\nworld!", 8);
    next.base_version = Some(7);
    next.changes = vec![
        LiveLanguageChange {
            start_line: 0,
            start_character: 3,
            end_line: 0,
            end_character: 8,
            text: "hi".into(),
        },
        LiveLanguageChange {
            start_line: 1,
            start_character: 5,
            end_line: 1,
            end_character: 5,
            text: "!".into(),
        },
    ];
    let changes = incremental_changes(&old, &next).unwrap();
    assert_eq!(changes.len(), 2);
    assert_eq!(changes[0]["range"]["start"]["character"], 3);
    next.base_version = Some(6);
    assert!(incremental_changes(&old, &next).is_none());
    next.base_version = Some(7);
    next.changes[0].start_character = 1;
    assert!(
        incremental_changes(&old, &next).is_none(),
        "Half a surrogate pair is never an edit boundary"
    );
}

const CONTRACT_PEER: &str = r#"
import sys,json
events=[]; pending={}; sequence=0
def send(value):
    body=json.dumps(value).encode();sys.stdout.buffer.write(b'Content-Length: '+str(len(body)).encode()+b'\r\n\r\n'+body);sys.stdout.buffer.flush()
def reply(id,result):send({'jsonrpc':'2.0','id':id,'result':result})
while True:
    length=0
    while True:
        line=sys.stdin.buffer.readline()
        if not line:sys.exit(0)
        if line in (b'\r\n',b'\n'):break
        if line.lower().startswith(b'content-length:'):length=int(line.split(b':',1)[1])
    msg=json.loads(sys.stdin.buffer.read(length));method=msg.get('method');params=msg.get('params',{});id=msg.get('id')
    if method=='initialize':reply(id,{'capabilities':json.loads(sys.argv[1])})
    elif method=='test/events':reply(id,events)
    elif method=='test/client':
        sequence+=1; key='client-'+str(sequence);pending[key]=id
        send({'jsonrpc':'2.0','id':key,'method':params['method'],'params':params['params']})
    elif method is not None:events.append(msg)
    elif id in pending:reply(pending.pop(id),msg)
"#;

#[test]
fn live_protocol_respects_sync_modes_scope_and_dynamic_registration_lifecycle() {
    tauri::async_runtime::block_on(async {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("main.ts"), "disk").unwrap();
        for (open_close_enabled, sync_kind, save) in [
            (false, 0, false),
            (false, 1, true),
            (true, 1, false),
            (true, 2, true),
        ] {
            let caps = json!({"textDocumentSync":{"openClose":open_close_enabled,"change":sync_kind,"save":if save {json!({"includeText":true})} else {json!(false)}},"completionProvider":{"triggerCharacters":["."]}});
            let e = entry(
                temp.path(),
                "python3",
                vec![
                    "-u".into(),
                    "-c".into(),
                    CONTRACT_PEER.into(),
                    caps.to_string(),
                ],
            );
            *e.session.live_settings.lock().unwrap() = json!({"python":{"pythonPath":"chosen"}});
            e.session.initialize().await.unwrap();
            synchronize(&e, document("first", 1), false).await.unwrap();
            synchronize(&e, document("saved", 2), true).await.unwrap();
            let log = e
                .session
                .rpc("events", "test/events", json!({}), None)
                .await
                .unwrap();
            let log = log.as_array().unwrap();
            assert_eq!(
                log.iter()
                    .filter(|m| m["method"] == "textDocument/didOpen")
                    .count(),
                usize::from(open_close_enabled)
            );
            let change = log.iter().find(|m| m["method"] == "textDocument/didChange");
            assert_eq!(change.is_some(), sync_kind != 0);
            if sync_kind == 1 {
                assert_eq!(
                    change.unwrap()["params"]["contentChanges"],
                    json!([{"text":"saved"}])
                );
            }
            if sync_kind == 2 {
                assert_eq!(
                    change.unwrap()["params"]["contentChanges"][0]["range"]["end"]["character"],
                    5
                );
            }
            let save_notification = log.iter().find(|m| m["method"] == "textDocument/didSave");
            assert_eq!(save_notification.is_some(), save);
            if save {
                assert_eq!(save_notification.unwrap()["params"]["text"], "saved");
            }
            let scoped=e.session.rpc("scope","test/client",json!({"method":"workspace/configuration","params":{"items":[{"scopeUri":url::Url::from_file_path(e.root.join("main.ts")).unwrap(),"section":"python"},{"scopeUri":"file:///outside-project/main.ts","section":"python"}]}}),None).await.unwrap();
            assert_eq!(scoped["result"], json!([{"pythonPath":"chosen"},null]));
            let registration = json!({"id":"dynamic","method":"textDocument/hover","registerOptions":{"documentSelector":[{"language":"typescript","pattern":"**/*.ts"}]}});
            let result=e.session.rpc("register","test/client",json!({"method":"client/registerCapability","params":{"registrations":[registration]}}),None).await.unwrap();
            assert!(result.get("error").is_none());
            assert!(e.session.supports_document(
                "textDocument/hover",
                &e.root.join("main.ts"),
                "typescript"
            ));
            assert!(!e.session.supports_document(
                "textDocument/hover",
                &e.root.join("main.py"),
                "python"
            ));
            e.session.rpc("unregister","test/client",json!({"method":"client/unregisterCapability","params":{"unregisterations":[{"id":"dynamic","method":"textDocument/hover"}]}}),None).await.unwrap();
            assert!(!e.session.supports_document(
                "textDocument/hover",
                &e.root.join("main.ts"),
                "typescript"
            ));
            assert_eq!(
                e.session.capability_data()["completionProvider"],
                caps["completionProvider"]
            );
            assert_eq!(
                fs::read_to_string(temp.path().join("main.ts")).unwrap(),
                "disk"
            );
            e.session.stop();
        }
    });
}

#[test]
fn repository_events_reach_only_registered_language_paths() {
    tauri::async_runtime::block_on(async {
        let temp = tempfile::tempdir().unwrap();
        let caps = json!({});
        let e = entry(
            temp.path(),
            "python3",
            vec![
                "-u".into(),
                "-c".into(),
                CONTRACT_PEER.into(),
                caps.to_string(),
            ],
        );
        e.session.initialize().await.unwrap();
        e.session.rpc("register","test/client",json!({"method":"client/registerCapability","params":{"registrations":[{"id":"watch","method":"workspace/didChangeWatchedFiles","registerOptions":{"watchers":[{"globPattern":"**/*.ts","kind":5}]}}]}}),None).await.unwrap();
        let manager = LiveLanguages::default();
        manager.0.lock().unwrap().insert("test".into(), e.clone());
        let changes = vec![
            RepositoryPathChange {
                path: "node_modules/library/index.ts".into(),
                kind: "created".into(),
            },
            RepositoryPathChange {
                path: "main.ts".into(),
                kind: "changed".into(),
            },
            RepositoryPathChange {
                path: "notes.md".into(),
                kind: "deleted".into(),
            },
        ];
        manager
            .repository_changed(
                &e.root,
                &RepositoryReadChange {
                    repository_id: "test".into(),
                    paths: changes.iter().map(|c| c.path.clone()).collect(),
                    changes: Some(changes),
                    generation: Some("test".into()),
                    sequence: Some(1),
                    tree: true,
                    git: false,
                    full: false,
                },
            )
            .await;
        let events = e
            .session
            .rpc("events", "test/events", json!({}), None)
            .await
            .unwrap();
        let watched = events
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["method"] == "workspace/didChangeWatchedFiles")
            .collect::<Vec<_>>();
        assert_eq!(watched.len(), 1);
        assert_eq!(watched[0]["params"]["changes"].as_array().unwrap().len(), 1);
        assert!(
            watched[0]["params"]["changes"][0]["uri"]
                .as_str()
                .unwrap()
                .ends_with("node_modules/library/index.ts")
        );
        e.session.stop();
    });
}

#[test]
fn configuration_changes_restart_only_the_affected_project() {
    tauri::async_runtime::block_on(async {
        let temp = tempfile::tempdir().unwrap();
        let storage = Storage::open(temp.path().join("private")).unwrap();
        let checkout = temp.path().join("repo");
        fs::create_dir_all(&checkout).unwrap();
        let checkout = checkout.canonicalize().unwrap();
        let manager = LiveLanguages::default();
        let mut entries = Vec::new();
        for name in ["a", "b"] {
            let dir = checkout.join(name);
            fs::create_dir(&dir).unwrap();
            fs::write(dir.join("tsconfig.json"), "{}").unwrap();
            let path = format!("{name}/main.ts");
            fs::write(checkout.join(&path), "export {};").unwrap();
            let project =
                super::super::project::resolve(&storage, &checkout, &path, "typescript").unwrap();
            let session = Session::spawn(
                LanguageServerConfig {
                    id: "typescript".into(),
                    name: "Test".into(),
                    extensions: vec!["ts".into()],
                    executable: "python3".into(),
                    arguments: vec!["-u".into(), "-c".into(), CONTRACT_PEER.into(), "{}".into()],
                },
                Workspace::live(project.root.clone()),
                vec![],
            )
            .unwrap();
            session.initialize().await.unwrap();
            let e = Arc::new(Entry {
                id: name.into(),
                root: checkout.clone(),
                session,
                documents: AsyncMutex::new(BTreeMap::new()),
                storage: Some(storage.clone()),
                source_path: path,
                context: project.context,
                configuration_paths: project.configuration_paths,
                scope: project.scope,
            });
            manager.0.lock().unwrap().insert(name.into(), e.clone());
            entries.push(e);
        }
        let notifications = Arc::new(Mutex::new(Vec::new()));
        let observed = notifications.clone();
        *entries[0].session.notifications.lock().unwrap() = Some(Arc::new(move |v| {
            observed
                .lock()
                .unwrap()
                .push(v["method"].as_str().unwrap().to_owned())
        }));
        fs::write(
            checkout.join("a/tsconfig.json"),
            "{\"compilerOptions\":{\"strict\":true}}",
        )
        .unwrap();
        manager
            .repository_changed(
                &checkout,
                &RepositoryReadChange {
                    repository_id: "test".into(),
                    paths: vec!["a/tsconfig.json".into()],
                    changes: Some(vec![RepositoryPathChange {
                        path: "a/tsconfig.json".into(),
                        kind: "changed".into(),
                    }]),
                    generation: Some("test".into()),
                    sequence: Some(1),
                    tree: false,
                    git: false,
                    full: false,
                },
            )
            .await;
        assert!(entries[0].session.is_stopped());
        assert!(!entries[1].session.is_stopped());
        assert_eq!(
            notifications
                .lock()
                .unwrap()
                .iter()
                .filter(|m| *m == "reviewbox/reconfigure")
                .count(),
            1
        );
        entries[1].session.stop();
    });
}

#[test]
fn a_new_nested_root_reconfigures_the_second_document_of_a_shared_session() {
    tauri::async_runtime::block_on(async {
        let temp = tempfile::tempdir().unwrap();
        let storage = Storage::open(temp.path().join("private")).unwrap();
        let checkout = temp.path().join("repo");
        fs::create_dir_all(checkout.join("a")).unwrap();
        fs::create_dir_all(checkout.join("b")).unwrap();
        let checkout = checkout.canonicalize().unwrap();
        fs::write(checkout.join("tsconfig.json"), "{}").unwrap();
        for name in ["a", "b"] {
            fs::write(checkout.join(name).join("main.ts"), "on disk").unwrap();
        }
        let project =
            super::super::project::resolve(&storage, &checkout, "a/main.ts", "typescript").unwrap();
        let second =
            super::super::project::resolve(&storage, &checkout, "b/main.ts", "typescript").unwrap();
        assert_eq!(project.context.signature, second.context.signature);
        let session = Session::spawn(
            LanguageServerConfig {
                id: "typescript".into(),
                name: "Test".into(),
                extensions: vec!["ts".into()],
                executable: "python3".into(),
                arguments: vec!["-u".into(), "-c".into(), CONTRACT_PEER.into(), "{}".into()],
            },
            Workspace::live(project.root.clone()),
            vec![],
        )
        .unwrap();
        session.initialize().await.unwrap();
        let e = Arc::new(Entry {
            id: "shared".into(),
            root: checkout.clone(),
            session,
            documents: AsyncMutex::new(BTreeMap::new()),
            storage: Some(storage.clone()),
            source_path: "a/main.ts".into(),
            context: project.context,
            configuration_paths: project.configuration_paths,
            scope: project.scope,
        });
        for name in ["a", "b"] {
            let mut doc = document(&format!("unsaved {name}"), 2);
            doc.path = format!("{name}/main.ts");
            synchronize(&e, doc, false).await.unwrap();
        }
        let manager = LiveLanguages::default();
        manager.0.lock().unwrap().insert("shared".into(), e.clone());
        fs::write(
            checkout.join("b/tsconfig.json"),
            "{\"compilerOptions\":{\"strict\":true}}",
        )
        .unwrap();
        manager
            .repository_changed(
                &checkout,
                &RepositoryReadChange {
                    repository_id: "test".into(),
                    paths: vec!["b/tsconfig.json".into()],
                    changes: Some(vec![RepositoryPathChange {
                        path: "b/tsconfig.json".into(),
                        kind: "created".into(),
                    }]),
                    generation: Some("test".into()),
                    sequence: Some(1),
                    tree: true,
                    git: false,
                    full: false,
                },
            )
            .await;
        assert!(e.session.is_stopped());
        assert_eq!(
            super::super::project::resolve(&storage, &checkout, "a/main.ts", "typescript")
                .unwrap()
                .root,
            checkout
        );
        assert_eq!(
            super::super::project::resolve(&storage, &checkout, "b/main.ts", "typescript")
                .unwrap()
                .root,
            checkout.join("b")
        );
        assert_eq!(e.documents.lock().await["b/main.ts"].text, "unsaved b");
        assert_eq!(
            fs::read_to_string(checkout.join("b/main.ts")).unwrap(),
            "on disk"
        );
    });
}

#[test]
#[ignore = "requires REVIEWBOX_REAL_TS/PYTHON/RUST/CLANGD executables"]
fn real_servers_complete_unsaved_documents() {
    tauri::async_runtime::block_on(async {
        for (env, name, language, text, expected, helper_path, helper, args) in [
            (
                "TS",
                "main.ts",
                "typescript",
                "import { meaning } from './helper';\nmeaning();\nconst fresh = { unsavedValue: 42 };\nfresh.",
                "unsavedValue",
                "helper.ts",
                "export function meaning() { return 42; }\n",
                vec!["--stdio".into()],
            ),
            (
                "PYTHON",
                "main.py",
                "python",
                "from helper import meaning\nmeaning()\nclass Fresh:\n    unsaved_value = 42\nfresh = Fresh()\nfresh.",
                "unsaved_value",
                "helper.py",
                "def meaning():\n    return 42\n",
                vec!["--stdio".into()],
            ),
            (
                "RUST",
                "src/main.rs",
                "rust",
                "mod helper;\nfn main() { helper::meaning(); let fresh = helper::Fresh { unsaved_value: 42 }; fresh. }",
                "unsaved_value",
                "src/helper.rs",
                "pub struct Fresh { pub unsaved_value: i32 }\npub fn meaning() -> i32 {42}\n",
                vec![],
            ),
            (
                "CLANGD",
                "main.cpp",
                "cpp",
                "#include \"helper.h\"\nint main() { meaning(); Fresh fresh; fresh.; }",
                "unsaved_value",
                "helper.h",
                "struct Fresh { int unsaved_value; };\nint meaning() { return 42; }\n",
                vec!["--background-index=false".into(), "--log=error".into()],
            ),
        ] {
            let line = text.lines().count() - 1;
            let character = text.lines().last().unwrap().find("fresh.").unwrap() + 6;
            let executable =
                std::env::var(format!("REVIEWBOX_REAL_{env}")).expect("real executable required");
            let temp = tempfile::tempdir().unwrap();
            fs::create_dir(temp.path().join("src")).unwrap();
            fs::write(
                temp.path().join("Cargo.toml"),
                "[package]\nname=\"live_test\"\nversion=\"0.1.0\"\nedition=\"2021\"\n",
            )
            .unwrap();
            fs::write(temp.path().join("package.json"), "{\"private\":true}").unwrap();
            fs::write(
                temp.path().join("tsconfig.json"),
                "{\"compilerOptions\":{\"strict\":true}}",
            )
            .unwrap();
            fs::write(
                temp.path().join(name),
                if language == "rust" {
                    "fn main() {}"
                } else {
                    ""
                },
            )
            .unwrap();
            fs::write(temp.path().join(helper_path), helper).unwrap();
            let disk = fs::read(temp.path().join(name)).unwrap();
            let e = entry(temp.path(), &executable, args);
            e.session.initialize().await.unwrap();
            synchronize(
                &e,
                LiveLanguageDocument {
                    path: name.into(),
                    version: 1,
                    text: text.into(),
                    language_id: language.into(),
                    base_version: None,
                    changes: vec![],
                },
                false,
            )
            .await
            .unwrap();
            let mut completed = false;
            for _ in 0..20 {
                let result = query(
                    &e,
                    "real",
                    name,
                    1,
                    "textDocument/completion",
                    json!({"position":{"line":line,"character":character}}),
                )
                .await;
                if let Ok(value) = result
                    && value.to_string().contains(expected)
                    && (env != "CLANGD" || value.to_string().contains("\"kind\":5"))
                {
                    completed = true;
                    break;
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            assert!(completed, "{language}: completion of unsaved member failed");
            let definition_line = text.lines().nth(1).unwrap();
            let definition = query(&e,"definition",name,1,"textDocument/definition",json!({"position":{"line":1,"character":definition_line.find("meaning").unwrap()+2}})).await.unwrap();
            assert!(
                definition.to_string().contains(helper_path),
                "{language}: cross-file definition failed: {definition}"
            );
            e.session.stop();
            assert_eq!(fs::read(temp.path().join(name)).unwrap(), disk);
            println!("{language}: unsaved completion and cross-file definition verified");
        }
    });
}
