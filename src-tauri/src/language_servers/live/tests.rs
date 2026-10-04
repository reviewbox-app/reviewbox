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
    })
}
fn document(text: &str, version: i32) -> LiveLanguageDocument {
    LiveLanguageDocument {
        path: "main.ts".into(),
        version,
        text: text.into(),
        language_id: "typescript".into(),
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
