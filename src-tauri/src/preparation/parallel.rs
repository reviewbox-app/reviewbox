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
                validate_analysis(&outline, &workspace.snapshot, storage)?;
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
                serde_json::to_value(schemars::schema_for!(JourneyOutline))
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
    Status(String, u64, PreparationStepStatus),
}
struct Completed {
    unit: Unit,
    value: Value,
}
#[derive(Clone)]
struct Worker {
    working_context_review_id: String,
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
        let queued = std::time::Instant::now();
        let _permit = self.permit(self.manager.slots.clone()).await?;
        let queue_ms = queued.elapsed().as_millis() as u64;
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
        let result = self.run_groups(units, &batch_id, queue_ms).await;
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
    async fn run_groups(&self, units: Vec<Unit>, batch_id: &str, queue_ms: u64) -> AppResult<()> {
        let mut groups = VecDeque::from([units]);
        let mut serial = 0;
        let mut backoff_ms = 0_u64;
        while let Some(mut pending) = groups.pop_front() {
            let mut feedback = json!({});
            let mut transient_retries = 0;
            while !pending.is_empty() {
                if self.cancel.load(Ordering::Relaxed) {
                    return Err(AppError::new("cancelled", "Preparation stopped."));
                }
                let waiting = std::time::Instant::now();
                let _retry = if self.manager.throttled.load(Ordering::Relaxed) {
                    self.batch_status(batch_id, PreparationBatchStatus::WaitingForProvider);
                    Some(self.permit(self.manager.retry_slot.clone()).await?)
                } else {
                    None
                };
                let provider_wait_ms = waiting.elapsed().as_millis() as u64;
                self.batch_status(batch_id, PreparationBatchStatus::Running);
                serial += 1;
                let manager = self.manager.clone();
                let operation = self.operation.clone();
                let namespace = format!("{batch_id}:{serial}");
                let run_id = self.run_id.clone();
                let cancel = self.cancel.clone();
                let observations = Arc::new(Mutex::new(BTreeMap::<String, Value>::new()));
                let observed = observations.clone();
                let timing = Arc::new(Mutex::new(metrics::ActivityTiming::default()));
                let observed_timing = timing.clone();
                let started_at = now();
                let started = std::time::Instant::now();
                let callback = Arc::new(move |mut event: AgentEvent| {
                    if let Ok(mut timing) = observed_timing.lock() {
                        timing.observe(&event, started.elapsed().as_millis() as u64);
                    }
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
                    (
                        "working_context".into(),
                        serde_json::to_string(&crate::working_context::prompt_context(
                            &self.storage,
                            &self.workspace.review.repository_id,
                            &self.working_context_review_id,
                            &self.workspace.snapshot.id,
                            !matches!(pending[0].kind, Kind::Documents),
                        )?)?,
                    ),
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
                let response = self
                    .runtime
                    .run(
                        &template,
                        variables,
                        pending[0].schema(),
                        callback,
                        !matches!(pending[0].kind, Kind::Documents),
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
                    operation.measurements.push(json!({"batchId":batch_id,"attempt":serial,"model":model,"phase":pending[0].phase,"items":pending.iter().map(|unit|unit.key.as_str()).collect::<Vec<_>>(),"startedAt":started_at,"endedAt":now(),"durationMs":started.elapsed().as_millis(),"queueWaitMs":if serial == 1 {queue_ms} else {0},"providerWaitMs":provider_wait_ms + backoff_ms,"activity":timing.lock().ok().map(|t|t.value(started.elapsed().as_millis() as u64)),"responseBytes":response.as_ref().ok().map(String::len),"errorCode":response.as_ref().err().map(|error|error.code.as_str()),"observations":observations.lock().map(|values|values.values().cloned().collect::<Vec<_>>()).unwrap_or_default()}));
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
                        let backoff = std::time::Instant::now();
                        for _ in 0..if transient_retries == 1 { 20 } else { 50 } {
                            if self.cancel.load(Ordering::Relaxed) {
                                return Err(AppError::new("cancelled", "Preparation stopped."));
                            }
                            tokio::time::sleep(Duration::from_millis(100)).await;
                        }
                        backoff_ms = backoff.elapsed().as_millis() as u64;
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
                backoff_ms = 0;
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
                    if matches!(unit.kind, Kind::Outline | Kind::Adaptation) {
                        value = value.and_then(|candidate| {
                            serde_json::from_value::<JourneyOutline>(candidate)
                                .ok()
                                .and_then(|outline| {
                                    serde_json::to_value(outline.into_outline()).ok()
                                })
                        });
                    }
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
                        let context_review_id = self.working_context_review_id.clone();
                        tokio::task::spawn_blocking(move || {
                            item.validate(&value, &workspace, &storage)?;
                            if matches!(item.kind, Kind::Outline | Kind::Adaptation)
                                && let Some(context) = crate::working_context::load(
                                    &storage,
                                    &workspace.review.repository_id,
                                    &context_review_id,
                                    &workspace.snapshot.id,
                                )?
                            {
                                let outline: Outline = serde_json::from_value(value)?;
                                crate::working_context::validate_assessments(
                                    &context,
                                    &outline.working_context_assessments,
                                )?;
                            }
                            Ok(())
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
fn document_input(topic: &OutlineTopic, step: &OutlineStep, sources: &[SourceDescriptor]) -> Value {
    let relevant: Vec<_> = sources
        .iter()
        .filter(|source| {
            step.context_source_ids.contains(&source.source_id)
                || step
                    .analysis
                    .as_ref()
                    .is_some_and(|a| a.evidence.iter().any(|e| e.source_id == source.source_id))
                || step.anchors.iter().any(|anchor| {
                    source
                        .source_id
                        .starts_with(&format!("change:{}:", anchor.change_id))
                })
        })
        .collect();
    let evidence: Vec<_> = relevant
        .iter()
        .map(|s| json!({"sourceId":s.source_id,"hash":s.hash,"readFromManifest":true}))
        .collect();
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
        let context_started_at = now();
        let context_started = std::time::Instant::now();
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
        if let Ok(mut active) = self.manager.active.lock()
            && let Some(operation) = active.get_mut(&self.key)
        {
            operation.measurements.push(json!({"phase":"context","attempt":1,"startedAt":context_started_at,"endedAt":now(),"durationMs":context_started.elapsed().as_millis()}));
        }
        let coordination =
            std::fs::read_to_string(self.resources.join("preparation/coordination.md"))?;
        let workspace = Arc::new(workspace);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let worker = Worker {
            working_context_review_id: self.checkpoint.state.review_id.clone(),
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
        let finalization_started_at = now();
        let finalization_started = std::time::Instant::now();
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
                    &step.context_sources(),
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
        let result = tokio::task::spawn_blocking(move || {
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
        .map_err(|e| AppError::new("task", e.to_string()))
        .and_then(|result| result);
        if let Ok(mut active) = self.manager.active.lock()
            && let Some(operation) = active.get_mut(&self.key)
        {
            operation.measurements.push(json!({"phase":"finalization","attempt":1,"startedAt":finalization_started_at,"endedAt":now(),"durationMs":finalization_started.elapsed().as_millis(),"errorCode":result.as_ref().err().map(|e| &e.code)}));
        }
        self.persist().await?;
        result
    }
    async fn record(&mut self, completed: Completed) -> AppResult<()> {
        if matches!(completed.unit.kind, Kind::Outline | Kind::Adaptation)
            && let Some(context) = &mut self.checkpoint.working_context
        {
            let outline: Outline = serde_json::from_value(completed.value.clone())?;
            crate::working_context::assess(
                &self.storage,
                context,
                &outline.working_context_assessments,
            )?;
        }
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
