//! Shared frozen context, role-specific models, and reusable Codex processes.
use super::*;

pub(crate) struct PreparationRuntime {
    context: String,
    _baseline: Option<exploration::Exploration>,
    exploration: exploration::Exploration,
    config: ProviderConfig,
    prepared: Option<codex::Prepared>,
    idle: tokio::sync::Mutex<Vec<codex::Session>>,
}
impl PreparationRuntime {
    pub(crate) async fn new(
        storage: Storage,
        workspace: Workspace,
        config: ProviderConfig,
        helper: String,
        cancel: Arc<AtomicBool>,
        baseline: Option<Workspace>,
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
        let (context, exploration, baseline) = tokio::task::spawn_blocking(move || {
            let mut context: Value =
                serde_json::from_str(&exploration::descriptor(&storage, &workspace, &request)?)?;
            let baseline = if let Some(old) = baseline {
                let old_request = AgentRequest {
                    id: id(),
                    review_id: old.review.id.clone(),
                    ..request.clone()
                };
                let descriptor: Value =
                    serde_json::from_str(&exploration::descriptor(&storage, &old, &old_request)?)?;
                context["previousReviewManifest"] = descriptor["reviewManifest"].clone();
                Some(exploration::materialize(
                    &storage,
                    &old,
                    &old_request,
                    &flag,
                )?)
            } else {
                None
            };
            Ok::<_, AppError>((
                serde_json::to_string_pretty(&context)?,
                exploration::materialize(&storage, &workspace, &request, &flag)?,
                baseline,
            ))
        })
        .await
        .map_err(|e| AppError::new("task", e.to_string()))??;
        let prepared = if config.provider == "codex" {
            Some(codex::prepare(&config, cancel.clone(), Some(helper)).await?)
        } else {
            None
        };
        Ok(Self {
            context,
            _baseline: baseline,
            exploration,
            config,
            prepared,
            idle: Default::default(),
        })
    }
    pub(crate) async fn run(
        &self,
        template: &str,
        mut variables: BTreeMap<String, String>,
        schema: Value,
        progress: Arc<dyn Fn(AgentEvent) + Send + Sync>,
        outline: Option<OutlineObserver>,
        cancel: Arc<AtomicBool>,
    ) -> AppResult<String> {
        variables.insert("context".into(), self.context.clone());
        let prompt = prompts::render(template, &variables)?;
        let config = self.config.clone();
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
            preview: outline.map(outline_preview::Preview::new),
        };
        if let Some(prepared) = self.prepared.clone() {
            let idle = self.idle.lock().await.pop();
            let mut session = match idle {
                Some(session) => session,
                None => {
                    codex::Session::start(
                        &self.exploration.project,
                        &config,
                        prepared,
                        cancel.clone(),
                    )
                    .await?
                }
            };
            session.set_cancel(cancel.clone());
            let result = session.run(&prompt, Some(schema), &mut stream).await;
            if result.is_ok() && session.reusable && !cancel.load(Ordering::Relaxed) {
                self.idle.lock().await.push(session);
            } else {
                session.finish().await;
            }
            result?;
        } else {
            claude::run(
                &self.exploration.project,
                &prompt,
                &config,
                cancel.clone(),
                &mut stream,
            )
            .await?;
        }
        Ok(stream.text)
    }
    pub(crate) async fn finish(&self) {
        for mut session in std::mem::take(&mut *self.idle.lock().await) {
            session.finish().await;
        }
    }
}
