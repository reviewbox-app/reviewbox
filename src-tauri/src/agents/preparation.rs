//! One read-only harness session over a materialized frozen capture.
use super::*;

// Leave headroom below provider limits, including JSON escaping and context.
const INLINE_PROMPT_BYTES: usize = 256 * 1024;
const MAX_PROMPT_BYTES: usize = 512 * 1024;

#[cfg(test)]
pub(crate) fn capture_summary(snapshot: &Snapshot) -> Value {
    let paths: std::collections::BTreeSet<_> = snapshot
        .files
        .iter()
        .map(|f| f.path.as_str())
        .chain(snapshot.changes.iter().map(|c| c.path.as_str()))
        .collect();
    let mut tree = BTreeMap::<String, usize>::new();
    for path in &paths {
        // The snapshot already excludes ignored untracked files. Keep tracked
        // files, and include deleted paths from the captured change list.
        let parts: Vec<_> = path.split('/').collect();
        let entry = if parts.len() > 2 {
            format!("{}/{}/", parts[0], parts[1])
        } else {
            (*path).to_owned()
        };
        *tree.entry(entry).or_default() += 1;
    }
    let mut bytes = 0;
    let mut entries = Vec::new();
    for (path, count) in &tree {
        let entry = serde_json::json!({"path":path,"files":count});
        let size = entry.to_string().len();
        if entries.len() == 100 || bytes + size > 16 * 1024 {
            break;
        }
        bytes += size;
        entries.push(entry);
    }
    serde_json::json!({
        "snapshotId":snapshot.id,"head":snapshot.head,"scope":snapshot.request,
        "fileCount":paths.len(),"changeCount":snapshot.changes.len(),
        "tree":entries,"omittedTreeEntries":tree.len()-entries.len(),
    })
}

fn bounded_prompt(
    directory: &std::path::Path,
    template: &str,
    mut variables: BTreeMap<String, String>,
) -> AppResult<String> {
    let prompt = prompts::render(template, &variables)?;
    if prompt.len() <= INLINE_PROMPT_BYTES {
        return Ok(prompt);
    }
    // Preserve the exact batch, including adaptation and correction data. Each
    // request owns unique files inside the exploration's temporary lifetime.
    for key in ["input", "correction"] {
        if let Some(value) = variables.get_mut(key)
            && value.len() > 1024
        {
            let path = directory.join(format!("{key}-{}.json", id()));
            std::fs::write(&path, value.as_bytes())?;
            *value = serde_json::to_string(&serde_json::json!({
                "readFromFile": path,
                "bytes": value.len(),
            }))?;
        }
    }
    let prompt = prompts::render(template, &variables)?;
    if prompt.len() > MAX_PROMPT_BYTES {
        return Err(AppError::new(
            "preparation_input_too_large",
            "The preparation instructions exceed the provider input budget. Completed results are kept.",
        ));
    }
    Ok(prompt)
}

pub(crate) struct PreparationRuntime {
    context: String,
    _baseline: Option<exploration::Exploration>,
    exploration: exploration::Exploration,
    config: ProviderConfig,
}
impl PreparationRuntime {
    pub(crate) async fn new(
        storage: Storage,
        workspace: Workspace,
        config: ProviderConfig,
        cancel: Arc<AtomicBool>,
        baseline: Option<Workspace>,
    ) -> AppResult<Self> {
        let request = exploration::ExplorationRequest {
            id: id(),
            paths: vec![],
        };
        let flag = cancel.clone();
        let (context, exploration, baseline) = tokio::task::spawn_blocking(move || {
            let mut context: Value =
                serde_json::from_str(&exploration::descriptor(&storage, &workspace, &request)?)?;
            let baseline = if let Some(old) = baseline {
                let old_request = exploration::ExplorationRequest {
                    id: id(),
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
        Ok(Self {
            context,
            _baseline: baseline,
            exploration,
            config,
        })
    }
    pub(crate) async fn run_session(
        &self,
        template: &str,
        variables: BTreeMap<String, String>,
        configuration: Value,
        progress: Arc<dyn Fn(AgentEvent) + Send + Sync>,
        cancel: Arc<AtomicBool>,
    ) -> AppResult<()> {
        let mut variables = variables;
        variables.insert("context".into(), self.context.clone());
        let prompt = bounded_prompt(&self.exploration.directory, template, variables)?;
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
            live_text: false,
            id: id(),
            sequence: 0,
            channel,
            text: String::new(),
            preview: None,
        };
        if self.config.provider == "codex" {
            let mut prepared = codex::prepare(&self.config, cancel.clone(), None).await?;
            prepared.helper = None;
            prepared.effort = self.config.reasoning_effort.clone();
            let mut session =
                codex::Session::start(&self.exploration.directory, &self.config, prepared, cancel)
                    .await?;
            session.preparation_tools(configuration);
            let result = session.run(&prompt, None, &mut stream).await;
            session.finish().await;
            result
        } else {
            claude::run_review_session(
                &self.exploration.directory,
                &prompt,
                &self.config,
                cancel,
                &mut stream,
                configuration,
            )
            .await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oversized_batches_keep_exact_data_outside_the_provider_message() {
        let directory = tempfile::tempdir().unwrap();
        let input = serde_json::json!({"items":[{"id":"outline","input":{"sources":
            (0..10_000).map(|i| serde_json::json!({"sourceId":format!("source-{i}"),"path":"long/path/".repeat(20)})).collect::<Vec<_>>()}}]}).to_string();
        assert!(input.len() > 1_048_576);
        let correction = "é\\\"{{context}}".repeat(50_000);
        let variables = BTreeMap::from([
            ("input".into(), input.clone()),
            ("correction".into(), correction.clone()),
        ]);
        for _ in 0..2 {
            let prompt = bounded_prompt(
                directory.path(),
                "{{input}}\n{{correction}}",
                variables.clone(),
            )
            .unwrap();
            assert!(prompt.len() < INLINE_PROMPT_BYTES);
            for (line, original) in prompt.lines().zip([&input, &correction]) {
                let pointer: Value = serde_json::from_str(line).unwrap();
                let path = std::path::Path::new(pointer["readFromFile"].as_str().unwrap());
                assert!(path.starts_with(directory.path()));
                assert_eq!(std::fs::read_to_string(path).unwrap(), *original);
            }
        }
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 4);
    }

    #[test]
    fn small_batches_remain_inline_and_oversized_instructions_fail_locally() {
        let directory = tempfile::tempdir().unwrap();
        let variables = BTreeMap::from([("input".into(), "{\"items\":[]}".into())]);
        assert_eq!(
            bounded_prompt(directory.path(), "{{input}}", variables.clone()).unwrap(),
            "{\"items\":[]}"
        );
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
        let error = bounded_prompt(
            directory.path(),
            &"x".repeat(MAX_PROMPT_BYTES + 1),
            variables,
        )
        .unwrap_err();
        assert_eq!(error.code, "preparation_input_too_large");
    }
}
