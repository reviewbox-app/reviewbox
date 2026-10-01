//! Bounded Codex scheduling; the Run remains the sole checkpoint/publication writer.
use super::*;
use std::{collections::VecDeque, time::Duration};
use tokio::sync::mpsc;
mod scheduler;
pub(super) use scheduler::Definition;

#[derive(Clone)]
enum Kind {
    Outline,
    Adaptation,
    Documents,
}
#[derive(Clone)]
struct Unit {
    key: String,
    label: String,
    phase: PreparationPhase,
    input: Value,
    kind: Kind,
    attempts: u8,
    version: u64,
}
impl Unit {
    fn template(&self) -> &'static str {
        match self.kind {
            Kind::Outline => "outline",
            Kind::Adaptation => "adaptation",
            Kind::Documents => "documents",
        }
    }
    fn validate(&self, value: &Value, workspace: &Workspace, storage: &Storage) -> AppResult<()> {
        match &self.kind {
            Kind::Outline | Kind::Adaptation => {
                let outline: Outline = serde_json::from_value(value.clone())?;
                validate_outline(&outline, &workspace.snapshot)?;
                if matches!(self.kind, Kind::Adaptation) {
                    let update = workspace
                        .review
                        .update_origin
                        .as_ref()
                        .ok_or_else(state_error)?;
                    adaptation::validate_outline_update(
                        &outline,
                        &storage.get::<Review>("review", &update.source_review_id)?,
                    )?;
                } else if !outline.removed_steps.is_empty()
                    || outline
                        .topics
                        .iter()
                        .flat_map(|t| &t.steps)
                        .any(|s| s.previous_step_id.is_some() || s.reuse)
                {
                    return Err(invalid(
                        "A new reading path cannot reference previous steps.",
                    ));
                }
                Ok(())
            }
            Kind::Documents => validate_documents(
                &serde_json::from_value(value.clone())?,
                &workspace.snapshot,
                storage,
            ),
        }
    }
    fn schema(&self) -> Value {
        let mut result = match self.kind {
            Kind::Outline | Kind::Adaptation => {
                serde_json::to_value(schemars::schema_for!(Outline))
            }
            Kind::Documents => serde_json::to_value(schemars::schema_for!(LevelDocuments)),
        }
        .expect("schema serialization");
        if matches!(self.kind, Kind::Documents) {
            if let Some(properties) = result.get_mut("properties").and_then(Value::as_object_mut) {
                properties.remove("dependencies");
            }
            if let Some(required) = result.get_mut("required").and_then(Value::as_array_mut) {
                required.retain(|key| key != "dependencies");
            }
        }
        // Aliases are assembled by the application, never authored by the model.
        // Keep the generation schema closed (structured outputs forbid free-form maps).
        if let Some(document) = result.pointer_mut("/$defs/ReviewDocument") {
            if let Some(properties) = document
                .get_mut("properties")
                .and_then(Value::as_object_mut)
            {
                properties.remove("termAliases");
            }
            if let Some(required) = document.get_mut("required").and_then(Value::as_array_mut) {
                required.retain(|name| name != "termAliases");
            }
        }
        let definitions = result
            .as_object_mut()
            .and_then(|object| object.remove("$defs"))
            .unwrap_or(json!({}));
        if let Some(object) = result.as_object_mut() {
            object.remove("$schema");
        }
        let mut schema = json!({"type":"object","additionalProperties":false,"required":["items"],"properties":{"items":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["id","result"],"properties":{"id":{"type":"string"},"result":result}}}},"$defs":definitions});
        strict_schema(&mut schema);
        schema
    }
}
// Codex structured outputs require every object to declare all its properties.
fn strict_schema(value: &mut Value) {
    match value {
        Value::Object(object) => {
            if object.get("type").is_some_and(|kind| kind == "object")
                && let Some(properties) = object.get("properties").and_then(Value::as_object)
            {
                let required = properties.keys().cloned().map(Value::String).collect();
                object.insert("required".into(), Value::Array(required));
                object.insert("additionalProperties".into(), Value::Bool(false));
            }
            for value in object.values_mut() {
                strict_schema(value);
            }
        }
        Value::Array(values) => {
            for value in values {
                strict_schema(value);
            }
        }
        _ => {}
    }
}
enum WorkUpdate {
    Completed(Completed),
    Preview(Vec<scheduler::Candidate>),
    Status(String, u64, PreparationStepStatus),
}
struct Completed {
    unit: Unit,
    value: Value,
}
#[derive(Clone)]
struct Worker {
    runtime: Arc<agents::PreparationRuntime>,
    manager: PreparationManager,
    operation: String,
    run_id: String,
    storage: Storage,
    workspace: Arc<Workspace>,
    templates: Arc<BTreeMap<String, String>>,
    coordination: String,
    glossary: Arc<Mutex<BTreeMap<String, Vec<DocumentTerm>>>>,
    helper: String,
    language: String,
    model: Option<String>,
    cancel: Arc<AtomicBool>,
    completed: mpsc::UnboundedSender<WorkUpdate>,
}
impl Worker {
    async fn permit(
        &self,
        semaphore: Arc<tokio::sync::Semaphore>,
    ) -> AppResult<tokio::sync::OwnedSemaphorePermit> {
        // Keep the same FIFO acquisition future while checking cancellation.
        let mut waiting = Box::pin(semaphore.acquire_owned());
        loop {
            if self.cancel.load(Ordering::Relaxed) {
                return Err(AppError::new("cancelled", "Preparation stopped."));
            }
            match tokio::time::timeout(Duration::from_millis(100), &mut waiting).await {
                Ok(result) => return result.map_err(|_| state_error()),
                Err(_) => continue,
            }
        }
    }
    async fn work(&self, units: Vec<Unit>) -> AppResult<()> {
        let _permit = self.permit(self.manager.slots.clone()).await?;
        let batch_id = id();
        if let Ok(mut active) = self.manager.active.lock()
            && let Some(operation) = active.get_mut(&self.operation)
            && operation.state.id == self.run_id
        {
            operation.state.active_batches.push(PreparationBatch {
                id: batch_id.clone(),
                label: units
                    .iter()
                    .map(|u| u.label.as_str())
                    .collect::<Vec<_>>()
                    .join(" · "),
                phase: units[0].phase.clone(),
                model: self.model.clone(),
                started_at: now(),
                status: PreparationBatchStatus::Running,
            });
        }
        let result = self.run_groups(units, &batch_id).await;
        if let Ok(mut active) = self.manager.active.lock()
            && let Some(operation) = active.get_mut(&self.operation)
            && operation.state.id == self.run_id
        {
            operation
                .state
                .active_batches
                .retain(|batch| batch.id != batch_id);
        }
        result
    }
    fn step_status(&self, unit: &Unit, status: PreparationStepStatus) {
        if !self.cancel.load(Ordering::Relaxed) {
            let _ = self
                .completed
                .send(WorkUpdate::Status(unit.key.clone(), unit.version, status));
        }
    }
    async fn run_groups(&self, units: Vec<Unit>, batch_id: &str) -> AppResult<()> {
        let mut groups = VecDeque::from([units]);
        let mut serial = 0;
        while let Some(mut pending) = groups.pop_front() {
            let mut feedback = json!({});
            let mut transient_retries = 0;
            while !pending.is_empty() {
                if self.cancel.load(Ordering::Relaxed) {
                    return Err(AppError::new("cancelled", "Preparation stopped."));
                }
                let _retry = if self.manager.throttled.load(Ordering::Relaxed) {
                    self.batch_status(batch_id, PreparationBatchStatus::WaitingForProvider);
                    Some(self.permit(self.manager.retry_slot.clone()).await?)
                } else {
                    None
                };
                self.batch_status(batch_id, PreparationBatchStatus::Running);
                serial += 1;
                let manager = self.manager.clone();
                let operation = self.operation.clone();
                let namespace = format!("{batch_id}:{serial}");
                let run_id = self.run_id.clone();
                let cancel = self.cancel.clone();
                let observations = Arc::new(Mutex::new(BTreeMap::<String, Value>::new()));
                let observed = observations.clone();
                let callback = Arc::new(move |mut event: AgentEvent| {
                    if cancel.load(Ordering::Relaxed) {
                        return;
                    }
                    if let Some(
                        progress @ (AgentProgress::Delegation { id, .. }
                        | AgentProgress::Usage { id, .. }),
                    ) = &event.progress
                        && let Ok(mut observed) = observed.lock()
                        && observed.len() < 32
                    {
                        let mut value = serde_json::to_value(progress).unwrap_or(Value::Null);
                        let key = format!("{}:{id}", value["type"].as_str().unwrap_or_default());
                        if value["type"] == "delegation"
                            && value["model"].is_null()
                            && let Some(previous) = observed.get(&key)
                        {
                            value["model"] = previous["model"].clone();
                        }
                        observed.insert(key, value);
                    }
                    event.run_id = format!("preparation:{run_id}");
                    manager.event(&operation, event, &namespace);
                });
                for unit in &pending {
                    self.step_status(unit, PreparationStepStatus::Writing);
                }
                let outline_observer: Option<agents::OutlineObserver> =
                    if matches!(pending[0].kind, Kind::Outline | Kind::Adaptation) {
                        self.completed
                            .send(WorkUpdate::Preview(vec![]))
                            .map_err(|_| state_error())?;
                        let tx = self.completed.clone();
                        let workspace = self.workspace.clone();
                        let cancel = self.cancel.clone();
                        Some(Arc::new(move |items: Vec<agents::OutlineItem>| {
                            if cancel.load(Ordering::Relaxed) {
                                return;
                            }
                            let steps = items
                                .into_iter()
                                .filter_map(|item| {
                                    let step: OutlineStep =
                                        serde_json::from_value(item.value).ok()?;
                                    let outline = Outline {
                                        removed_steps: vec![],
                                        topics: vec![OutlineTopic {
                                            title: item.title.clone(),
                                            brief: item.brief.clone(),
                                            steps: vec![step.clone()],
                                        }],
                                    };
                                    validate_outline(&outline, &workspace.snapshot).ok()?;
                                    Some(scheduler::Candidate {
                                        topic: outline.topics.into_iter().next()?,
                                        order: (item.topic, item.step),
                                    })
                                })
                                .collect();
                            let _ = tx.send(WorkUpdate::Preview(steps));
                        }))
                    } else {
                        None
                    };
                let model = self.model.clone();
                let known_glossary = self
                    .glossary
                    .lock()
                    .map_err(|_| state_error())?
                    .values()
                    .flatten()
                    .cloned()
                    .collect::<Vec<_>>();
                let variables = BTreeMap::from([
                    ("language".into(), self.language.clone()),
                    ("helper_model".into(), self.helper.clone()),
                    (
                        "input".into(),
                        serde_json::to_string(
                            &json!({"knownGlossary":known_glossary,"items":pending.iter().map(|u| json!({"id":u.key,"input":u.input})).collect::<Vec<_>>()}),
                        )?,
                    ),
                    (
                        "schema".into(),
                        serde_json::to_string(&pending[0].schema())?,
                    ),
                    ("correction".into(), serde_json::to_string(&feedback)?),
                ]);
                let template = format!(
                    "{}\n\n{}",
                    self.templates[pending[0].template()],
                    self.coordination
                );
                let started = std::time::Instant::now();
                let response = self
                    .runtime
                    .run(
                        &template,
                        variables,
                        pending[0].schema(),
                        callback,
                        outline_observer,
                        self.cancel.clone(),
                    )
                    .await;
                self.manager.event(
                    &self.operation,
                    AgentEvent {
                        batch_id: None,
                        run_id: format!("preparation:{}", self.run_id),
                        sequence: 0,
                        kind: "batchFinished".into(),
                        text: String::new(),
                        progress: None,
                    },
                    &format!("{batch_id}:{serial}"),
                );
                if let Ok(mut active) = self.manager.active.lock()
                    && let Some(operation) = active.get_mut(&self.operation)
                    && operation.state.id == self.run_id
                {
                    operation.measurements.push(json!({"batchId":batch_id,"attempt":serial,"model":model,"phase":pending[0].phase,"items":pending.iter().map(|unit|unit.key.as_str()).collect::<Vec<_>>(),"durationMs":started.elapsed().as_millis(),"responseBytes":response.as_ref().ok().map(String::len),"errorCode":response.as_ref().err().map(|error|error.code.as_str()),"observations":observations.lock().map(|values|values.values().cloned().collect::<Vec<_>>()).unwrap_or_default()}));
                    if operation.measurements.len() > 2000 {
                        operation.measurements.remove(0);
                    }
                }
                let response = match response {
                    Err(error) if error.code == "provider_rate_limit" && transient_retries < 2 => {
                        self.manager.throttled.store(true, Ordering::Relaxed);
                        self.batch_status(batch_id, PreparationBatchStatus::WaitingForProvider);
                        transient_retries += 1;
                        let mut event = AgentEvent {
                            batch_id: None,
                            run_id: format!("preparation:{}", self.run_id),
                            sequence: 0,
                            kind: "status".into(),
                            text: "Waiting for Codex capacity; parallel work has been reduced."
                                .into(),
                            progress: None,
                        };
                        event.batch_id = Some(batch_id.into());
                        self.manager.event(&self.operation, event, batch_id);
                        for _ in 0..if transient_retries == 1 { 20 } else { 50 } {
                            if self.cancel.load(Ordering::Relaxed) {
                                return Err(AppError::new("cancelled", "Preparation stopped."));
                            }
                            tokio::time::sleep(Duration::from_millis(100)).await;
                        }
                        continue;
                    }
                    Err(error) if error.code == "output_limit" && pending.len() > 1 => {
                        let other = pending.split_off(pending.len() / 2);
                        groups.push_front(other);
                        groups.push_front(pending);
                        break;
                    }
                    Err(error) if error.code != "output_limit" => return Err(error),
                    other => other,
                };
                let parsed = response
                    .as_ref()
                    .ok()
                    .and_then(|text| serde_json::from_str::<Value>(text).ok());
                let values = parsed.as_ref().and_then(|value| value["items"].as_array());
                let mut retry = Vec::new();
                let mut errors = Vec::new();
                for mut unit in pending {
                    self.step_status(&unit, PreparationStepStatus::Checking);
                    // A duplicate or missing id invalidates that item only.
                    // Unknown ids never enter the checkpoint or publication.
                    let mut value = values.and_then(|values| {
                        let mut matches = values.iter().filter(|value| value["id"] == unit.key);
                        let value = matches.next()?;
                        matches.next().is_none().then(|| value["result"].clone())
                    });
                    if matches!(unit.kind, Kind::Documents)
                        && let Some(candidate) = &value
                        && let Ok(mut documents) =
                            serde_json::from_value::<LevelDocuments>(candidate.clone())
                    {
                        reader::glossary::inherit(&mut documents, &known_glossary);
                        value = Some(serde_json::to_value(documents)?);
                    }
                    let validated = if let Some(value) = value.clone() {
                        let item = unit.clone();
                        let workspace = self.workspace.clone();
                        let storage = self.storage.clone();
                        tokio::task::spawn_blocking(move || {
                            item.validate(&value, &workspace, &storage)
                        })
                        .await
                        .map_err(|e| AppError::new("task", e.to_string()))?
                    } else {
                        Err(invalid(
                            "Return the requested id and a complete result matching its schema.",
                        ))
                    };
                    if self.cancel.load(Ordering::Relaxed) {
                        return Err(AppError::new("cancelled", "Preparation stopped."));
                    }
                    match validated {
                        Ok(()) => {
                            if matches!(unit.kind, Kind::Documents) {
                                let documents = reader::glossary::canonicalize(
                                    serde_json::from_value(value.clone().unwrap_or(Value::Null))?,
                                );
                                value = Some(serde_json::to_value(&documents)?);
                            }
                            self.completed
                                .send(WorkUpdate::Completed(Completed {
                                    unit,
                                    value: value.unwrap_or(Value::Null),
                                }))
                                .map_err(|_| state_error())?;
                        }
                        Err(error) if unit.attempts < 3 => {
                            unit.attempts += 1;
                            errors.push(
                                json!({"id":unit.key,"error":error.message,"previousResult":value}),
                            );
                            retry.push(unit);
                        }
                        Err(error) => {
                            return Err(AppError::new(
                                "invalid_preparation",
                                format!(
                                    "{} remains invalid after three corrections: {}",
                                    unit.label, error.message
                                ),
                            ));
                        }
                    }
                }
                pending = retry;
                feedback = json!({"items":errors});
            }
        }
        Ok(())
    }
    fn batch_status(&self, batch_id: &str, status: PreparationBatchStatus) {
        if let Ok(mut active) = self.manager.active.lock()
            && let Some(operation) = active.get_mut(&self.operation)
            && operation.state.id == self.run_id
            && let Some(batch) = operation
                .state
                .active_batches
                .iter_mut()
                .find(|batch| batch.id == batch_id)
        {
            batch.status = status;
        }
    }
}
fn unit(key: String, label: String, phase: PreparationPhase, input: Value, kind: Kind) -> Unit {
    Unit {
        key,
        label,
        phase,
        input,
        kind,
        attempts: 0,
        version: 0,
    }
}
// Inline complete small sources, with explicit manifest lookups for larger ones.
// Never send a truncated source as though it were the complete captured file.
fn document_evidence(
    sources: &[&SourceDescriptor],
    inline: &BTreeMap<String, String>,
) -> Vec<Value> {
    let mut remaining = 64 * 1024;
    sources.iter().map(|source| {
        if let Some(text) = inline.get(&source.hash) && text.len() <= remaining {
            remaining -= text.len();
            json!({"sourceId":source.source_id,"hash":source.hash,"startLine":1,"text":text,"complete":true})
        } else {
            json!({"sourceId":source.source_id,"hash":source.hash,"complete":false,"readFromManifest":true})
        }
    }).collect()
}

fn document_input(
    topic: &OutlineTopic,
    step: &OutlineStep,
    sources: &[SourceDescriptor],
    inline: &BTreeMap<String, String>,
) -> Value {
    let relevant: Vec<_> = sources
        .iter()
        .filter(|source| {
            step.context_source_ids.contains(&source.source_id)
                || step.anchors.iter().any(|anchor| {
                    source
                        .source_id
                        .starts_with(&format!("change:{}:", anchor.change_id))
                })
        })
        .collect();
    let evidence = document_evidence(&relevant, inline);
    json!({"scope":"readingStep","topic":topic.title,"brief":topic.brief,"step":step,"sources":relevant,"capturedSources":evidence})
}

impl Run {
    pub(super) async fn execute_parallel(
        &mut self,
        workspace: Workspace,
        sources: Vec<SourceDescriptor>,
    ) -> AppResult<()> {
        let config = self.config.clone().ok_or_else(state_error)?;
        let storage = self.storage.clone();
        let mut helper =
            tokio::task::spawn_blocking(move || agents::settings(&storage).map(|s| s.helper_model))
                .await
                .map_err(|e| AppError::new("task", e.to_string()))??;
        if config.provider != "codex" {
            helper = config
                .model
                .clone()
                .unwrap_or_else(|| "claude-sonnet-5".into());
        }
        if self
            .checkpoint
            .helper_model
            .as_ref()
            .is_some_and(|previous| previous != &helper)
        {
            return Err(AppError::new(
                "preparation_changed",
                "The helper model changed. Start a new preparation.",
            ));
        }
        self.checkpoint.helper_model = Some(helper.clone());
        self.persist().await?;
        let runtime = Arc::new(
            agents::PreparationRuntime::new(
                self.storage.clone(),
                workspace.clone(),
                config.clone(),
                helper.clone(),
                self.cancel.clone(),
                if let Some(update) = &self.checkpoint.state.adaptation {
                    Some(reviews::load(&self.storage, &update.source_review_id)?)
                } else {
                    None
                },
            )
            .await?,
        );
        let coordination =
            std::fs::read_to_string(self.resources.join("preparation/coordination.md"))?;
        let workspace = Arc::new(workspace);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let worker = Worker {
            runtime: runtime.clone(),
            manager: self.manager.clone(),
            operation: self.key.clone(),
            run_id: self.checkpoint.state.id.clone(),
            storage: self.storage.clone(),
            workspace: workspace.clone(),
            templates: Arc::new(self.templates.clone()),
            coordination,
            glossary: Arc::new(Mutex::new(BTreeMap::new())),
            helper: helper.clone(),
            language: self.language.clone(),
            model: config.model.clone(),
            cancel: self.cancel.clone(),
            completed: tx,
        };
        let result = self.schedule(&worker, &sources, &mut rx).await;
        runtime.finish().await;
        result
    }
    async fn schedule(
        &mut self,
        worker: &Worker,
        sources: &[SourceDescriptor],
        rx: &mut mpsc::UnboundedReceiver<WorkUpdate>,
    ) -> AppResult<()> {
        let workspace = &worker.workspace;
        let files = reader::files(&workspace.snapshot);
        let baseline = self
            .checkpoint
            .state
            .adaptation
            .as_ref()
            .map(|u| reviews::load(&self.storage, &u.source_review_id))
            .transpose()?;
        let signature = adaptation::generation_signature(self)?;
        let reused_steps =
            scheduler::schedule(self, worker, sources, baseline, &signature, rx).await?;
        self.check_cancel()?;
        let outline: Outline = serde_json::from_value(self.checkpoint.results["outline"].clone())?;
        let mut topics = Vec::new();
        for (ti, topic) in outline.topics.into_iter().enumerate() {
            let mut steps = Vec::new();
            for (si, step) in topic.steps.into_iter().enumerate() {
                let mut documents: LevelDocuments = serde_json::from_value(
                    self.checkpoint.results[&format!("step:{}", step.draft_id)].clone(),
                )?;
                adaptation::attach_dependencies(
                    &mut documents,
                    &step.anchors,
                    &step.context_source_ids,
                    &workspace.snapshot,
                    &signature,
                )?;
                steps.push(Step {
                    id: step
                        .previous_step_id
                        .unwrap_or_else(|| format!("{}-step-{ti}-{si}", self.checkpoint.state.id)),
                    title: step.title,
                    anchors: step.anchors,
                    documents,
                });
            }
            topics.push(Topic {
                id: format!("{}-topic-{ti}", self.checkpoint.state.id),
                title: topic.title,
                brief: topic.brief,
                steps,
            });
        }
        let contents = files
            .into_iter()
            .map(|file| ReviewFileContent {
                file_id: file.id,
                documents: None,
            })
            .collect();
        self.update(|state| state.phase = PreparationPhase::Checking);
        self.persist().await?;
        self.check_cancel()?;
        let storage = self.storage.clone();
        let state = self.checkpoint.state.clone();
        let target_review = workspace.review.id.clone();
        let revision = workspace.review.revision;
        let cancel = self.cancel.clone();
        tokio::task::spawn_blocking(move || {
            if cancel.load(Ordering::Relaxed) {
                return Err(AppError::new(
                    "cancelled",
                    "Update stopped before installation.",
                ));
            }
            reader::publish_preparation(
                &storage,
                &target_review,
                &state.snapshot_id,
                &state.id,
                revision,
                topics,
                contents,
            )?;
            if state.adaptation.is_some() {
                adaptation::finish(&storage, &state, &reused_steps)?;
            }
            Ok::<_, AppError>(())
        })
        .await
        .map_err(|e| AppError::new("task", e.to_string()))??;
        Ok(())
    }
    async fn record(&mut self, completed: Completed) -> AppResult<()> {
        let key = completed.unit.key;
        self.checkpoint.results.insert(key.clone(), completed.value);
        if let Some(operation) = self
            .manager
            .active
            .lock()
            .map_err(|_| state_error())?
            .get(&self.key)
        {
            self.checkpoint.state = operation.state.clone();
        }
        if let Some(step) = self
            .checkpoint
            .state
            .steps
            .iter_mut()
            .find(|step| step.id == key)
        {
            step.status = PreparationStepStatus::Ready;
        }
        self.save_checkpoint().await?;
        self.update(|state| {
            if let Some(step) = state.steps.iter_mut().find(|step| step.id == key) {
                step.status = PreparationStepStatus::Ready;
            }
        });
        Ok(())
    }
}

#[cfg(all(test, unix))]
mod tests;
