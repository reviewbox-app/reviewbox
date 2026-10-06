//! Ephemeral, window-scoped conversations. The native owner resolves every attachment.
use super::*;
use serde_json::json;
use tauri::State;

#[derive(Default)]
pub struct ChatManager {
    conversations: Mutex<HashMap<String, Conversation>>,
}
struct Conversation {
    owner: String,
    repository: String,
    review: String,
    history: Vec<Value>,
    contexts: Vec<exploration::Exploration>,
    active: Option<(String, Arc<AtomicBool>)>,
}
impl ChatManager {
    pub fn release_window(&self, owner: &str) {
        if let Ok(mut conversations) = self.conversations.lock() {
            conversations.retain(|_, c| {
                if c.owner != owner {
                    return true;
                }
                if let Some((_, cancel)) = &c.active {
                    cancel.store(true, Ordering::Relaxed);
                }
                false
            });
        }
    }
}
fn chat_error(mut error: AppError) -> AppError {
    if error.code.starts_with("provider_") {
        let reason = error
            .details
            .as_deref()
            .and_then(|details| serde_json::from_str::<Value>(details).ok())
            .and_then(|details| {
                details["result"]
                    .as_str()
                    .or_else(|| details["message"].as_str())
                    .map(str::to_owned)
            });
        error.message = reason.filter(|s| !s.trim().is_empty()).map_or_else(
            || "Rev could not answer. Check the harness status in Settings, then retry.".into(),
            |reason| {
                format!(
                    "Rev could not answer. {}",
                    reason.chars().take(1200).collect::<String>()
                )
            },
        );
    }
    error
}
fn state_error() -> AppError {
    AppError::new("chat_state", "Rev conversation is unavailable.")
}
#[tauri::command]
pub async fn rev_chat_send(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    storage: State<'_, Storage>,
    manager: State<'_, ChatManager>,
    request: RevChatRequest,
    channel: Channel<AgentEvent>,
) -> AppResult<String> {
    if request.message.trim().is_empty() || request.message.len() > 64 * 1024 {
        return Err(AppError::new(
            "chat_message",
            "Enter a question of at most 64 KiB.",
        ));
    }
    let resources = crate::commands::resource_root(&app)?;
    let cancel = Arc::new(AtomicBool::new(false));
    let history = {
        let mut chats = manager.conversations.lock().map_err(|_| state_error())?;
        let c = chats
            .entry(request.conversation_id.clone())
            .or_insert_with(|| Conversation {
                owner: window.label().into(),
                repository: request.repository_id.clone(),
                review: request.review_id.clone(),
                history: Vec::new(),
                contexts: Vec::new(),
                active: None,
            });
        if c.owner != window.label()
            || c.repository != request.repository_id
            || c.review != request.review_id
        {
            return Err(state_error());
        }
        if c.active.is_some() {
            return Err(AppError::new(
                "chat_busy",
                "Wait for Rev or stop the current response.",
            ));
        }
        c.active = Some((request.operation_id.clone(), cancel.clone()));
        c.history.clone()
    };
    let mut result = run(
        storage.inner().clone(),
        resources,
        &request,
        history,
        cancel.clone(),
        channel,
    )
    .await;
    if let Ok(mut chats) = manager.conversations.lock()
        && let Some(c) = chats.get_mut(&request.conversation_id)
        && c.active
            .as_ref()
            .is_some_and(|(id, _)| id == &request.operation_id)
    {
        c.active = None;
        if !cancel.load(Ordering::Relaxed)
            && let Ok((history, _, context)) = &mut result
        {
            c.history = std::mem::take(history);
            if let Some(context) = context.take() {
                c.contexts.push(context);
            }
        }
    }
    if cancel.load(Ordering::Relaxed) {
        return Err(AppError::new("cancelled", "Response stopped."));
    }
    result.map(|(_, text, _)| text).map_err(chat_error)
}
#[tauri::command]
pub fn rev_chat_cancel(
    window: tauri::WebviewWindow,
    manager: State<'_, ChatManager>,
    conversation_id: String,
) -> AppResult<()> {
    let chats = manager.conversations.lock().map_err(|_| state_error())?;
    if let Some(c) = chats
        .get(&conversation_id)
        .filter(|c| c.owner == window.label())
        && let Some((_, flag)) = &c.active
    {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}
#[tauri::command]
pub fn rev_chat_close(
    window: tauri::WebviewWindow,
    manager: State<'_, ChatManager>,
    conversation_id: String,
) -> AppResult<()> {
    let mut chats = manager.conversations.lock().map_err(|_| state_error())?;
    if chats
        .get(&conversation_id)
        .is_some_and(|c| c.owner == window.label())
        && let Some(c) = chats.remove(&conversation_id)
        && let Some((_, flag)) = c.active
    {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}
async fn run(
    storage: Storage,
    resources: PathBuf,
    request: &RevChatRequest,
    mut history: Vec<Value>,
    cancel: Arc<AtomicBool>,
    channel: Channel<AgentEvent>,
) -> AppResult<(Vec<Value>, String, Option<exploration::Exploration>)> {
    let context_storage = storage.clone();
    let context_request = request.clone();
    let context_cancel = cancel.clone();
    let (exploration, context, language) = tauri::async_runtime::spawn_blocking(move || -> AppResult<_> {
        let scoped = context_storage.scoped(Some(&context_request.repository_id));
        let workspace = reviews::load(&scoped, &context_request.review_id)?;
        if workspace.review.repository_id != context_request.repository_id { return Err(state_error()); }
        let selection = &context_request.context.selection;
        let excerpt = crate::review_documents::verify(&workspace, selection)?;
        let step = crate::review_documents::step(&workspace.review, &selection.step_id)?;
        let document = step.documents.get(selection.level);
        let term = if let Some(id) = &context_request.context.term_id {
            Some(document.terms.iter().chain(step.documents.glossary.iter()).chain(workspace.review.glossary.iter()).find(|t| &t.id == id).cloned().ok_or_else(|| AppError::new("chat_context", "This glossary entry no longer exists."))?)
        } else { None };
        let mut context = json!({"role":"user", "message":context_request.message,"step":step.title,"selection":selection,"selectedText":excerpt,"document":document,"term":term});
        let exploration = exploration::materialize(&scoped, &workspace, &exploration::ExplorationRequest { id: id(), paths: vec![] }, &context_cancel)?;
        context["sourceManifest"] = json!(exploration.directory.join("manifest.json"));
        Ok((exploration, context, storage_language(&context_storage, &context_request.repository_id)?))
    }).await.map_err(|e| AppError::new("chat_context", e.to_string()))??;
    history.push(context);
    let attachment = exploration.directory.join("conversation.json");
    std::fs::write(
        &attachment,
        serde_json::to_vec(&json!({"language":language,"messages":history}))?,
    )?;
    let template = std::fs::read_to_string(resources.join("prompts/review-chat.md"))?;
    let prompt = prompts::render(&template, &BTreeMap::from([("context".into(), json!({"conversation":attachment,"sources":exploration.directory.join("manifest.json")}).to_string())]))?;
    let settings = settings(&storage)?;
    let project = storage.project_settings(&request.repository_id)?;
    let provider = project
        .provider
        .as_deref()
        .unwrap_or(&settings.default_provider);
    let config = settings
        .providers
        .iter()
        .find(|c| c.provider == provider)
        .cloned()
        .ok_or_else(|| AppError::new("provider", "Configure Rev in Settings first."))?;
    let config = models::for_project(config, project);
    let mut stream = Stream {
        live_text: true,
        id: request.operation_id.clone(),
        sequence: 0,
        channel,
        text: String::new(),
        preview: None,
    };
    if config.provider == "codex" {
        let prepared = codex::prepare(&config, cancel.clone(), None).await?;
        let mut session = codex::Session::start_with_delegation(
            &exploration.project,
            &config,
            prepared,
            cancel,
            false,
        )
        .await?;
        session.read_only();
        let result = session.run(&prompt, None, &mut stream).await;
        session.finish().await;
        result?;
    } else if config.provider == "claude" {
        claude::run_consultation(&exploration.project, &prompt, &config, cancel, &mut stream)
            .await?;
    } else {
        return Err(AppError::new(
            "provider",
            "This harness does not support Ask Rev.",
        ));
    }
    history.push(json!({"role":"assistant","message":stream.text}));
    Ok((history, stream.text, Some(exploration)))
}
fn storage_language(storage: &Storage, repository: &str) -> AppResult<String> {
    Ok(storage.project_settings(repository)?.language)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "Requires the installed authenticated Codex; run explicitly for native validation"]
    async fn live_codex_consultation_is_read_only() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("sample.txt");
        std::fs::write(&source, "frozen-value-42").unwrap();
        let config = ProviderConfig {
            provider: "codex".into(),
            executable: "codex".into(),
            model: None,
        };
        let cancel = Arc::new(AtomicBool::new(false));
        let prepared = codex::prepare(&config, cancel.clone(), None).await.unwrap();
        let mut session =
            codex::Session::start_with_delegation(temp.path(), &config, prepared, cancel, false)
                .await
                .unwrap();
        session.read_only();
        let mut stream = Stream {
            live_text: true,
            id: id(),
            sequence: 0,
            channel: Channel::new(|_| Ok(())),
            text: String::new(),
            preview: None,
        };
        let prompt = "Use the terminal to read sample.txt in this test directory. Then attempt to overwrite only this disposable test file with changed: it must be denied. Report the original contents and whether the write was denied. Do not access any other files or tools.";
        let result = tokio::time::timeout(
            Duration::from_secs(90),
            session.run(prompt, None, &mut stream),
        )
        .await;
        session.finish().await;
        result.unwrap().unwrap();
        assert_eq!(std::fs::read_to_string(&source).unwrap(), "frozen-value-42");
        assert!(stream.text.contains("frozen-value-42"), "{}", stream.text);
        println!("{}", stream.text);
    }
}
