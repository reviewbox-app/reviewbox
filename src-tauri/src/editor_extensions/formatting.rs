//! Formatting computes text only. The editor owns version checks and source writes.
use crate::{contracts::*, language_servers::catalog, processes::ProcessGroup, storage::Storage};
use serde_json::json;
use std::{process::Stdio, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tauri::command]
pub async fn format_editor_document(
    storage: tauri::State<'_, Storage>,
    repository_id: String,
    path: String,
    text: String,
    range_start: Option<u32>,
    range_end: Option<u32>,
) -> AppResult<Option<String>> {
    format(
        &storage,
        &repository_id,
        &path,
        text,
        range_start,
        range_end,
    )
    .await
}
async fn format(
    storage: &Storage,
    repository: &str,
    path: &str,
    text: String,
    start: Option<u32>,
    end: Option<u32>,
) -> AppResult<Option<String>> {
    super::require_engine(storage, "prettier")?;
    if text.len() as u64 > crate::editor::MAX_TEXT
        || start
            .zip(end)
            .is_some_and(|(s, e)| s > e || e as usize > text.encode_utf16().count())
    {
        return Err(AppError::new(
            "format_input",
            "Invalid formatting range or document size.",
        ));
    }
    let root = crate::repositories::root(storage, repository)?;
    let file = crate::editor::path(&root, path)?;
    let engine = catalog::installed(storage, "prettier")?.ok_or_else(|| {
        AppError::new(
            "formatter_unavailable",
            "Prettier is not ready. Retry in Settings > Extensions.",
        )
    })?;
    let fallback = engine.directory.ok_or_else(|| {
        AppError::new("formatter_unavailable", "The private formatter is missing.")
    })?;
    let mut command = tokio::process::Command::new(engine.executable);
    command
        .args([
            "--input-type=module",
            "-e",
            include_str!("../../../resources/editor/prettier.mjs"),
        ])
        .current_dir(&root)
        .envs(engine.environment)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn()?;
    let group = ProcessGroup::new(
        child
            .id()
            .ok_or_else(|| AppError::new("formatter", "The formatter could not start."))?,
    );
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| AppError::new("formatter", "Missing formatter input."))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::new("formatter", "Missing formatter output."))?;
    let input = serde_json::to_vec(
        &json!({"filepath":file,"text":text,"fallback":fallback,"root":root,"rangeStart":start,"rangeEnd":end}),
    )?;
    let work = async {
        stdin.write_all(&input).await?;
        drop(stdin);
        let mut bytes = Vec::new();
        stdout
            .take(crate::editor::MAX_TEXT + 1024 * 1024)
            .read_to_end(&mut bytes)
            .await?;
        let _ = child.wait().await?;
        let result: serde_json::Value = serde_json::from_slice(&bytes)?;
        if let Some(error) = result["error"].as_str() {
            return Err(AppError::new(
                "prettier",
                error.chars().take(2000).collect::<String>(),
            ));
        }
        super::require_engine(storage, "prettier")?;
        let text = result["text"].as_str().map(str::to_owned);
        if text
            .as_ref()
            .is_some_and(|t| t.len() as u64 > crate::editor::MAX_TEXT)
        {
            return Err(AppError::new(
                "formatter",
                "Formatted document exceeds the editor limit.",
            ));
        }
        Ok(text)
    };
    let disabled = async {
        loop {
            tokio::time::sleep(Duration::from_millis(100)).await;
            if !super::enabled(storage, EditorExtensionId::Prettier)? {
                return Err(AppError::new(
                    "extension_disabled",
                    "Prettier was disabled.",
                ));
            }
        }
    };
    let result = tokio::select! {
        result = work => result,
        result = disabled => result,
        _ = tokio::time::sleep(Duration::from_millis(2500)) => Err(AppError::new("format_timeout", "Formatting took too long. The file can still be saved.")),
    };
    group.terminate();
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf, process::Command};
    #[test]
    #[ignore = "Requires REVIEWBOX_EXTENSION_FIXTURES and REVIEWBOX_LANGUAGE_SMOKE_DIR; installs the pinned private formatter"]
    fn prettier_respects_project_plugins_config_ignore_and_disable() {
        let fixtures =
            PathBuf::from(std::env::var_os("REVIEWBOX_EXTENSION_FIXTURES").expect("fixtures"));
        let storage = Storage::open(PathBuf::from(
            std::env::var_os("REVIEWBOX_LANGUAGE_SMOKE_DIR").expect("engines"),
        ))
        .unwrap();
        let root = fixtures.join("web");
        assert!(
            Command::new("git")
                .args(["init", "--quiet"])
                .current_dir(&root)
                .status()
                .unwrap()
                .success()
        );
        fs::write(root.join(".gitignore"), "node_modules/\n").unwrap();
        let repository = crate::repositories::open(&storage, root.to_str().unwrap()).unwrap();
        tauri::async_runtime::block_on(async {
            let installer = crate::language_servers::install::LanguageServerInstaller::default();
            let operation = installer
                .start(storage.clone(), "prettier".into(), None)
                .unwrap();
            loop {
                let state = installer
                    .operations()
                    .into_iter()
                    .find(|o| o.id == operation.id)
                    .unwrap();
                if !matches!(state.status.as_str(), "queued" | "installing") {
                    assert_eq!(state.status, "ready", "{}", state.message);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            let code = "const answer={ text: \"hello\" };\n";
            let formatted = format(&storage, &repository.id, "main.ts", code.into(), None, None)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(formatted, "const answer = { text: 'hello' }\n");
            assert_eq!(
                format(
                    &storage,
                    &repository.id,
                    "ignored.ts",
                    code.into(),
                    None,
                    None
                )
                .await
                .unwrap(),
                None
            );
            let code = "const first={ text: \"hello\" };\nconst second={value:2};\n";
            let formatted = format(
                &storage,
                &repository.id,
                "main.ts",
                code.into(),
                Some(0),
                Some(30),
            )
            .await
            .unwrap()
            .unwrap();
            assert!(
                formatted.contains("const second={value:2};"),
                "range formatting leaves the other statement: {formatted}"
            );
            let config = root.join(".prettierrc.json");
            let previous = fs::read(&config).unwrap();
            fs::write(root.join("fixture-plugin.cjs"),r#"module.exports={languages:[{name:'Fixture',parsers:['fixture'],extensions:['.fixturefmt']}],parsers:{fixture:{parse:text=>({text}),astFormat:'fixture',locStart:()=>0,locEnd:ast=>ast.text.length}},printers:{fixture:{print:path=>'formatted('+path.getValue().text+')'}}}"#).unwrap();
            fs::write(
                &config,
                r#"{"plugins":["./fixture-plugin.cjs"],"parser":"fixture"}"#,
            )
            .unwrap();
            let result = format(
                &storage,
                &repository.id,
                "main.fixturefmt",
                "custom".into(),
                None,
                None,
            )
            .await;
            fs::write(config, previous).unwrap();
            assert_eq!(result.unwrap().unwrap(), "formatted(custom)");
            crate::editor_extensions::update(&storage, EditorExtensionId::Prettier, false).unwrap();
            assert_eq!(
                format(&storage, &repository.id, "main.ts", code.into(), None, None)
                    .await
                    .unwrap_err()
                    .code,
                "extension_disabled"
            );
            crate::editor_extensions::update(&storage, EditorExtensionId::Prettier, true).unwrap();
            eprintln!("Verified Prettier project config, selection, ignore, plugin and disable");
        });
    }
}
