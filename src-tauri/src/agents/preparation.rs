//! Shared frozen context, role-specific models, and reusable Codex processes.
use super::*;

pub(crate) struct PreparationRuntime {
    context: String,
    exploration: exploration::Exploration,
    config: ProviderConfig,
    prepared: Option<codex::Prepared>,
    idle: tokio::sync::Mutex<BTreeMap<bool, Vec<codex::Session>>>,
    cancel: Arc<AtomicBool>,
}
impl PreparationRuntime {
    pub(crate) async fn new(
        storage: Storage,
        workspace: Workspace,
        config: ProviderConfig,
        helper: String,
        cancel: Arc<AtomicBool>,
    ) -> AppResult<Self> {
        let request = AgentRequest {
            id: id(),
            review_id: workspace.review.id.clone(),
            provider: config.provider.clone(),
            action: "preparation".into(),
            request: String::new(),
            paths: vec![],
        };
        let flag = cancel.clone();
        let (context, exploration) = tokio::task::spawn_blocking(move || {
            Ok::<_, AppError>((
                exploration::descriptor(&storage, &workspace, &request)?,
                exploration::materialize(&storage, &workspace, &request, &flag)?,
            ))
        })
        .await
        .map_err(|e| AppError::new("task", e.to_string()))??;
        let prepared = if config.provider == "codex" {
            Some(codex::prepare(&config, cancel.clone(), Some(helper)).await?)
        } else {
            let catalog = models::discover(&config, cancel.clone()).await?;
            if !catalog.iter().any(|model| {
                model.id == "claude-sonnet-5"
                    || model.resolved_model.as_deref() == Some("claude-sonnet-5")
            }) {
                return Err(AppError::new(
                    "translation_model",
                    "The translation model claude-sonnet-5 is unavailable. No alternative model was selected.",
                ));
            }
            None
        };
        Ok(Self {
            context,
            exploration,
            config,
            prepared,
            idle: Default::default(),
            cancel,
        })
    }
    pub(crate) async fn run(
        &self,
        translation: bool,
        template: &str,
        mut variables: BTreeMap<String, String>,
        schema: Value,
        progress: Arc<dyn Fn(AgentEvent) + Send + Sync>,
    ) -> AppResult<String> {
        variables.insert("context".into(), self.context.clone());
        let prompt = prompts::render(template, &variables)?;
        let mut config = self.config.clone();
        if translation {
            config.model = Some(
                if config.provider == "codex" {
                    "gpt-6-luna"
                } else {
                    "claude-sonnet-5"
                }
                .into(),
            );
        }
        let channel = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(text) = body
                && let Ok(event) = serde_json::from_str::<AgentEvent>(&text)
                && event.kind != "delta"
            {
                progress(event);
            }
            Ok(())
        });
        let mut stream = Stream {
            id: id(),
            sequence: 0,
            channel,
            text: String::new(),
        };
        if let Some(mut prepared) = self.prepared.clone() {
            if translation {
                prepared.effort = prepared.translation_effort.clone();
                prepared.helper = Some("gpt-6-luna".into());
            }
            let idle = self.idle.lock().await.entry(translation).or_default().pop();
            let mut session = match idle {
                Some(session) => session,
                None => {
                    codex::Session::start(
                        &self.exploration.project,
                        &config,
                        prepared,
                        self.cancel.clone(),
                    )
                    .await?
                }
            };
            let result = session.run(&prompt, Some(schema), &mut stream).await;
            if result.is_ok() && session.reusable {
                self.idle
                    .lock()
                    .await
                    .entry(translation)
                    .or_default()
                    .push(session);
            } else {
                session.finish().await;
            }
            result?;
        } else {
            claude::run(
                &self.exploration.project,
                &prompt,
                &config,
                self.cancel.clone(),
                &mut stream,
            )
            .await?;
        }
        Ok(stream.text)
    }
    pub(crate) async fn finish(&self) {
        for mut session in std::mem::take(&mut *self.idle.lock().await)
            .into_values()
            .flatten()
        {
            session.finish().await;
        }
    }
}
