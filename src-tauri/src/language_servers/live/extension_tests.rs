//! Opt-in checks against installed, pinned engines and disposable npm fixtures.
use super::*;
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

fn installed_entry(storage: &Storage, root: &Path, path: &str, id: &str) -> Arc<Entry> {
    let root = root.canonicalize().unwrap();
    let server = catalog::resolve_language(storage, path, None, Some(id)).unwrap();
    let project = super::super::project::resolve(storage, &root, path, id).unwrap();
    let session = Session::spawn(
        server.clone(),
        Workspace::live(project.root.clone()),
        catalog::launch_environment(storage, &server).unwrap(),
    )
    .unwrap();
    *session.live_settings.lock().unwrap() = project.settings;
    *session.live_initialization_options.lock().unwrap() = project.initialization_options;
    Arc::new(Entry {
        id: format!("test-{id}"),
        session,
        root: root.clone(),
        documents: AsyncMutex::new(BTreeMap::new()),
        storage: None,
        source_path: path.into(),
        context: project.context,
        configuration_paths: project.configuration_paths,
        scope: root,
    })
}
async fn document(entry: &Entry, path: &str, language: &str, text: &str, version: i32) {
    synchronize(
        entry,
        LiveLanguageDocument {
            path: path.into(),
            language_id: language.into(),
            version,
            text: text.into(),
            base_version: None,
            changes: vec![],
        },
        false,
    )
    .await
    .unwrap();
}
async fn ask(entry: &Entry, path: &str, version: i32, method: &str, params: Value) -> Value {
    query(
        entry,
        &uuid::Uuid::new_v4().to_string(),
        path,
        version,
        method,
        params,
    )
    .await
    .unwrap_or_else(|e| panic!("{} {method}: {e:?}", entry.session.server.id))
}
fn items(value: &Value) -> Vec<Value> {
    value
        .as_array()
        .or_else(|| value["items"].as_array())
        .cloned()
        .unwrap_or_default()
}
#[test]
#[ignore = "Requires REVIEWBOX_EXTENSION_FIXTURES and REVIEWBOX_LANGUAGE_SMOKE_DIR prepared by the extension validation script"]
fn real_extension_engines_edit_unsaved_projects() {
    let fixture =
        PathBuf::from(std::env::var_os("REVIEWBOX_EXTENSION_FIXTURES").expect("fixtures"));
    let storage = Storage::open(PathBuf::from(
        std::env::var_os("REVIEWBOX_LANGUAGE_SMOKE_DIR").expect("engines"),
    ))
    .unwrap();
    tauri::async_runtime::block_on(async {
        let installer = super::super::install::LanguageServerInstaller::default();
        for id in ["typescript", "vue", "tailwind", "prisma", "slang"] {
            if catalog::installed(&storage, id).unwrap().is_some_and(|r| {
                r.version == catalog::spec(id).unwrap().version
                    && Path::new(&r.executable).is_file()
            }) {
                continue;
            }
            let operation = installer.start(storage.clone(), id.into(), None).unwrap();
            loop {
                let state = installer
                    .operations()
                    .into_iter()
                    .find(|o| o.id == operation.id)
                    .unwrap();
                if !matches!(state.status.as_str(), "queued" | "installing") {
                    assert_eq!(state.status, "ready", "{id}: {}", state.message);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        }
        let web = fixture.join("web");
        fs::write(web.join("src/main.tsx"), "// persisted source\n").unwrap();
        fs::write(web.join("App.vue"), "<template></template>\n").unwrap();
        let ts = installed_entry(&storage, &web, "src/main.tsx", "typescript");
        ts.session.initialize().await.unwrap();
        let source = "export const Card = () => <article><b /></article>;\nReviewB";
        document(&ts, "src/main.tsx", "typescriptreact", source, 1).await;
        let mut completion = Value::Null;
        for _ in 0..20 {
            completion = ask(
                &ts,
                "src/main.tsx",
                1,
                "textDocument/completion",
                json!({"position":{"line":1,"character":7},"context":{"triggerKind":1}}),
            )
            .await;
            if items(&completion)
                .iter()
                .any(|i| i["label"] == "ReviewButton")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        let item = items(&completion)
            .into_iter()
            .find(|i| i["label"] == "ReviewButton")
            .expect("React auto import completion");
        let resolved = ask(&ts, "src/main.tsx", 1, "completionItem/resolve", item).await;
        assert!(
            resolved["additionalTextEdits"]
                .as_array()
                .is_some_and(|e| !e.is_empty()),
            "resolved auto-import: {resolved}"
        );
        let linked = ask(
            &ts,
            "src/main.tsx",
            1,
            "textDocument/linkedEditingRange",
            json!({"position":{"line":0,"character":29}}),
        )
        .await;
        assert_eq!(
            linked["ranges"].as_array().unwrap().len(),
            2,
            "nested JSX linked editing"
        );
        document(
            &ts,
            "src/main.tsx",
            "typescriptreact",
            "import { ReviewButton } from '@/Button';\nReviewButton",
            2,
        )
        .await;
        let definition = ask(
            &ts,
            "src/main.tsx",
            2,
            "textDocument/definition",
            json!({"position":{"line":1,"character":3}}),
        )
        .await;
        assert!(
            definition.to_string().contains("Button.tsx"),
            "alias definition: {definition}"
        );
        eprintln!(
            "Verified React: unsaved completion, resolved import, linked tags and alias navigation"
        );

        let vue = installed_entry(&storage, &web, "App.vue", "vue");
        vue.session.initialize().await.unwrap();
        let source = "<script setup lang=\"ts\">\nconst count = 42;\n</script>\n<template><p>{{ count.toF }}</p></template>";
        document(&vue, "App.vue", "vue", source, 1).await;
        let mut completion = Value::Null;
        for _ in 0..20 {
            completion = ask(
                &vue,
                "App.vue",
                1,
                "textDocument/completion",
                json!({"position":{"line":3,"character":24},"context":{"triggerKind":1}}),
            )
            .await;
            if items(&completion).iter().any(|i| i["label"] == "toFixed") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        assert!(
            items(&completion).iter().any(|i| i["label"] == "toFixed"),
            "typed Vue template: {completion}"
        );
        let hover = ask(
            &vue,
            "App.vue",
            1,
            "textDocument/hover",
            json!({"position":{"line":3,"character":18}}),
        )
        .await;
        assert!(
            hover.to_string().contains("number") || hover.to_string().contains("42"),
            "Vue hover: {hover}"
        );
        eprintln!("Verified Vue: template completion and TypeScript hover from unsaved buffer");
        fs::write(web.join("src/state.ts"), "export const count = 'disk';\n").unwrap();
        document(
            &ts,
            "src/state.ts",
            "typescript",
            "export const count = 123;\n",
            1,
        )
        .await;
        let manager = LiveLanguages::default();
        manager.0.lock().unwrap().insert("ts".into(), ts.clone());
        manager.0.lock().unwrap().insert("vue".into(), vue.clone());
        let state = ts.documents.lock().await["src/state.ts"].clone();
        manager.mirror(&ts, &state).await;
        document(&vue, "App.vue", "vue", "<script setup lang=\"ts\">\nimport { count } from './src/state';\n</script>\n<template><p>{{ count.toF }}</p></template>", 2).await;
        let completion = ask(
            &vue,
            "App.vue",
            2,
            "textDocument/completion",
            json!({"position":{"line":3,"character":24},"context":{"triggerKind":1}}),
        )
        .await;
        assert!(
            items(&completion).iter().any(|i| i["label"] == "toFixed"),
            "Vue sees unsaved TypeScript import: {completion}"
        );
        assert!(
            fs::read_to_string(web.join("src/state.ts"))
                .unwrap()
                .contains("'disk'")
        );
        assert!(
            !vue.documents.lock().await.contains_key("src/state.ts"),
            "mirrored buffers must not keep a session alive"
        );
        eprintln!(
            "Verified Vue–TypeScript: cross-session unsaved import without writing source files"
        );

        for name in ["tailwind3", "tailwind4"] {
            let root = fixture.join(name);
            let tailwind = installed_entry(&storage, &root, "main.tsx", "tailwind");
            tailwind.session.initialize().await.unwrap();
            document(
                &tailwind,
                "main.tsx",
                "typescriptreact",
                "export const Card = () => <div className=\"bg-brand flex\"></div>\n",
                1,
            )
            .await;
            for _ in 0..50 {
                if tailwind.session.supports_document(
                    "textDocument/completion",
                    &tailwind.root.join("main.tsx"),
                    "typescriptreact",
                ) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            let mut completion = Value::Null;
            for _ in 0..20 {
                completion = ask(
                    &tailwind,
                    "main.tsx",
                    1,
                    "textDocument/completion",
                    json!({"position":{"line":0,"character":45},"context":{"triggerKind":1}}),
                )
                .await;
                if items(&completion).iter().any(|i| i["label"] == "bg-brand") {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            assert!(
                items(&completion).iter().any(|i| i["label"] == "bg-brand"),
                "{name} custom class: {completion}"
            );
            let colors = ask(
                &tailwind,
                "main.tsx",
                1,
                "textDocument/documentColor",
                json!({}),
            )
            .await;
            assert!(
                colors.as_array().is_some_and(|c| !c.is_empty()),
                "{name} computed colors: {colors}"
            );
            eprintln!(
                "Verified {name}: project configuration, class completion and computed colors"
            );
        }
        let root = fixture.join("prisma");
        fs::create_dir_all(root.join("prisma")).unwrap();
        fs::write(
            root.join("package.json"),
            r#"{"prisma":{"schema":"prisma"}}"#,
        )
        .unwrap();
        fs::write(root.join("prisma/schema.prisma"),"generator client {\n provider = \"prisma-client-js\"\n}\ndatasource db {\n provider = \"sqlite\"\n}\n").unwrap();
        fs::write(
            root.join("prisma/user.prisma"),
            "model User {\n id Int @id\n posts Post[]\n}\n",
        )
        .unwrap();
        let prisma = installed_entry(&storage, &root, "prisma/post.prisma", "prisma");
        prisma.session.initialize().await.unwrap();
        document(&prisma,"prisma/post.prisma","prisma","model Post {\n id Int @id\n author User @relation(fields: [authorId], references: [id])\n authorId Int\n}\n",1).await;
        let definition = ask(
            &prisma,
            "prisma/post.prisma",
            1,
            "textDocument/definition",
            json!({"position":{"line":2,"character":10}}),
        )
        .await;
        assert!(
            definition.to_string().contains("user.prisma"),
            "Prisma multifile definition: {definition}"
        );
        eprintln!("Verified Prisma: navigation across schema files");
        // slangd canonicalizes source paths; the editor always creates a file before opening it.
        fs::write(web.join("main.hlsl"), "// persisted source\n").unwrap();
        let shader = installed_entry(&storage, &web, "main.hlsl", "slang");
        shader.session.initialize().await.unwrap();
        document(&shader,"main.hlsl","hlsl","float4 tint(float4 color) { return color; }\nfloat4 main() : SV_Target { return tint(float4(1,0,0,1)); }",1).await;
        let mut hover = Value::Null;
        for _ in 0..20 {
            hover = ask(
                &shader,
                "main.hlsl",
                1,
                "textDocument/hover",
                json!({"position":{"line":1,"character":36}}),
            )
            .await;
            if !hover.is_null() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        assert!(!hover.is_null(), "HLSL hover");
        eprintln!("Verified HLSL: unsaved shader hover");
    });
}
