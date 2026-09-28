//! Bounded Codex scheduling; the Run remains the sole checkpoint/publication writer.
use super::*;
use cache::{TranslationCache, rebase, relative};
use std::{collections::VecDeque, time::Duration};
use tokio::{sync::mpsc, task::JoinSet};

#[derive(Clone)]
enum Kind {
    Outline,
    Documents,
    Translation(Segment),
}
#[derive(Clone)]
struct Binding {
    key: String,
    offset: u32,
}
#[derive(Clone)]
struct Unit {
    key: String,
    label: String,
    phase: PreparationPhase,
    input: Value,
    kind: Kind,
    bindings: Vec<Binding>,
    cache_key: Option<String>,
    attempts: u8,
}
impl Unit {
    fn template(&self) -> &'static str {
        match self.kind {
            Kind::Outline => "outline",
            Kind::Documents => "documents",
            Kind::Translation(_) => "pseudocode",
        }
    }
    fn validate(&self, value: &Value, workspace: &Workspace, storage: &Storage) -> AppResult<()> {
        match &self.kind {
            Kind::Outline => {
                validate_outline(&serde_json::from_value(value.clone())?, &workspace.snapshot)
            }
            Kind::Documents => validate_documents(
                &serde_json::from_value(value.clone())?,
                &workspace.snapshot,
                storage,
            ),
            Kind::Translation(segment) => {
                validate_translation(&serde_json::from_value(value.clone())?, segment)
            }
        }
    }
    fn schema(&self) -> Value {
        let mut result = match self.kind {
            Kind::Outline => serde_json::to_value(schemars::schema_for!(Outline)),
            Kind::Documents => serde_json::to_value(schemars::schema_for!(LevelDocuments)),
            Kind::Translation(_) => serde_json::to_value(schemars::schema_for!(TranslationResult)),
        }
        .expect("schema serialization");
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
    translation_model: String,
    language: String,
    model: Option<String>,
    cancel: Arc<AtomicBool>,
    completed: mpsc::UnboundedSender<Completed>,
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
        let translation = matches!(units[0].kind, Kind::Translation(_));
        let _category = self
            .permit(if translation {
                self.manager.translation_slots.clone()
            } else {
                self.manager.document_slots.clone()
            })
            .await?;
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
                model: if translation {
                    Some(self.translation_model.clone())
                } else {
                    self.model.clone()
                },
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
                let translation = matches!(pending[0].kind, Kind::Translation(_));
                let model = if translation {
                    Some(self.translation_model.clone())
                } else {
                    self.model.clone()
                };
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
                    (
                        "helper_model".into(),
                        if translation {
                            self.translation_model.clone()
                        } else {
                            self.helper.clone()
                        },
                    ),
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
                        translation,
                        &template,
                        variables,
                        pending[0].schema(),
                        callback,
                    )
                    .await;
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
                                self.glossary.lock().map_err(|_| state_error())?.insert(
                                    unit.key.clone(),
                                    documents
                                        .glossary
                                        .iter()
                                        .chain(&documents.beginner.terms)
                                        .chain(&documents.intermediate.terms)
                                        .chain(&documents.developer.terms)
                                        .cloned()
                                        .collect(),
                                );
                            }
                            self.completed
                                .send(Completed {
                                    unit,
                                    value: value.unwrap_or(Value::Null),
                                })
                                .map_err(|_| state_error())?;
                        }
                        Err(error) if unit.attempts < 3 => {
                            unit.attempts += 1;
                            errors.push(
                                json!({"id":unit.key,"error":error.message,"previousResult":value}),
                            );
                            retry.push(unit);
                        }
                        Err(error) => match unit.kind {
                            Kind::Translation(_) => {
                                self.completed.send(Completed { unit, value: json!({"unavailable":"Rev could not produce a faithful translation after three corrections."}) }).map_err(|_| state_error())?;
                            }
                            _ => {
                                return Err(AppError::new(
                                    "invalid_preparation",
                                    format!(
                                        "{} remains invalid after three corrections: {}",
                                        unit.label, error.message
                                    ),
                                ));
                            }
                        },
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
        bindings: vec![Binding {
            key: key.clone(),
            offset: 0,
        }],
        key,
        label,
        phase,
        input,
        kind,
        cache_key: None,
        attempts: 0,
    }
}
fn group(units: Vec<Unit>, size: usize) -> VecDeque<Vec<Unit>> {
    let mut groups: VecDeque<Vec<Unit>> = VecDeque::new();
    for unit in units {
        if let Some(last) = groups.back_mut()
            && last.len() < size
            && last[0].phase == unit.phase
        {
            last.push(unit);
        } else {
            groups.push_back(vec![unit]);
        }
    }
    groups
}

// Group complete versions by logical file, including renamed paths.
// Keep each content independently checkpointed; no source is truncated to fit.
fn translation_groups(mut units: Vec<Unit>) -> VecDeque<Vec<Unit>> {
    fn file(unit: &Unit) -> &str {
        unit.input["fileId"]
            .as_str()
            .or_else(|| unit.input["file"].as_str())
            .unwrap_or_default()
    }
    units.sort_by(|a, b| file(a).cmp(file(b)).then(a.key.cmp(&b.key)));
    let mut groups = VecDeque::new();
    let mut current = Vec::new();
    let mut files = std::collections::BTreeSet::new();
    for unit in units {
        let path = file(&unit).to_owned();
        if !current.is_empty() && (!files.contains(&path) && files.len() == 9) {
            groups.push_back(std::mem::take(&mut current));
            files.clear();
        }
        files.insert(path);
        current.push(unit);
    }
    if !current.is_empty() {
        groups.push_back(current);
    }
    groups
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
        let translation_model = if config.provider == "codex" {
            "gpt-6-luna"
        } else {
            helper = "claude-sonnet-5".into();
            "claude-sonnet-5"
        }
        .to_owned();
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
            glossary: Arc::new(Mutex::new(
                self.checkpoint
                    .results
                    .iter()
                    .filter_map(|(key, value)| {
                        serde_json::from_value::<LevelDocuments>(value.clone())
                            .ok()
                            .map(|docs| {
                                (
                                    key.clone(),
                                    docs.glossary
                                        .iter()
                                        .chain(&docs.beginner.terms)
                                        .chain(&docs.intermediate.terms)
                                        .chain(&docs.developer.terms)
                                        .cloned()
                                        .collect(),
                                )
                            })
                    })
                    .collect(),
            )),
            helper: helper.clone(),
            translation_model,
            language: self.language.clone(),
            model: config.model.clone(),
            cancel: self.cancel.clone(),
            completed: tx,
        };
        let cache_storage = self.storage.clone();
        let cache = tokio::task::spawn_blocking(move || TranslationCache::new(&cache_storage))
            .await
            .map_err(|e| AppError::new("task", e.to_string()))??;
        let result = self.schedule(&worker, &cache, &sources, &mut rx).await;
        runtime.finish().await;
        result
    }
    async fn schedule(
        &mut self,
        worker: &Worker,
        cache: &TranslationCache,
        sources: &[SourceDescriptor],
        rx: &mut mpsc::UnboundedReceiver<Completed>,
    ) -> AppResult<()> {
        let workspace = &worker.workspace;
        let files = reader::files(&workspace.snapshot);
        let source_files: BTreeMap<_, _> = files
            .iter()
            .flat_map(|file| {
                file.translations
                    .iter()
                    .map(|source| (source.source_id.clone(), file.id.clone()))
            })
            .collect();
        let mut registered = BTreeMap::new();
        let outline = unit(
            "outline".into(),
            "Organizing the reading path and choosing files to translate".into(),
            PreparationPhase::Outline,
            json!({"sources":sources,"files":files}),
            Kind::Outline,
        );
        registered.insert("outline".into(), PreparationPhase::Outline);
        self.update(|state| state.phase = PreparationPhase::Outline);
        if let Some(value) = self.checkpoint.results.get("outline") {
            outline.validate(value, workspace, &self.storage)?;
        } else {
            // No translation or cache lookup starts until Rev has selected its scope.
            worker.work(vec![outline]).await?;
            while let Ok(completed) = rx.try_recv() {
                self.record(completed, cache).await?;
            }
        }
        let outline: Outline = serde_json::from_value(self.checkpoint.results["outline"].clone())?;
        let selected_sources = outline.translation_sources(&workspace.snapshot);
        self.update(|state| {
            state.translation_selection = Some(outline.translation_selection(&workspace.snapshot))
        });
        self.persist().await?;
        self.check_cancel()?;
        let mut translations: BTreeMap<String, Vec<Unit>> = BTreeMap::new();
        let mut inline_sources = BTreeMap::new();
        let mut unavailable = BTreeMap::new();
        let mut dedup: BTreeMap<String, Unit> = BTreeMap::new();
        let translation_contract = serde_json::to_value(schemars::schema_for!(TranslationResult))?;
        for source in sources
            .iter()
            .filter(|s| s.source_id.starts_with("change:"))
        {
            if translations.contains_key(&source.hash) || unavailable.contains_key(&source.hash) {
                continue;
            }
            if !selected_sources.contains(&source.source_id) && source.size > 32 * 1024 {
                continue;
            }
            let storage = self.storage.clone();
            let snapshot = workspace.snapshot.clone();
            let source_id = source.source_id.clone();
            let frozen = tokio::task::spawn_blocking(move || {
                reader::source(&storage, &snapshot, &source_id)
            })
            .await
            .map_err(|e| AppError::new("task", e.to_string()))??;
            let Some(text) = frozen.text else {
                unavailable.insert(
                    source.hash.clone(),
                    frozen
                        .unavailable_reason
                        .unwrap_or_else(|| "This source is not text.".into()),
                );
                continue;
            };
            if text.len() <= 32 * 1024 {
                inline_sources.insert(source.hash.clone(), text.clone());
            }
            if !selected_sources.contains(&source.source_id) {
                continue;
            }
            let parts = match segments(&text) {
                Ok(parts) => parts,
                Err(error) if error.code == "translation_unavailable" => {
                    unavailable.insert(source.hash.clone(), error.message);
                    continue;
                }
                Err(error) => return Err(error),
            };
            let mut items = Vec::new();
            for part in parts {
                let segment = relative(&part);
                let format = Path::new(&source.path)
                    .extension()
                    .and_then(|s| s.to_str())
                    .unwrap_or_default();
                let key = fingerprint(&serde_json::to_vec(&json!([
                    source.hash,
                    format,
                    "English",
                    self.templates["pseudocode"],
                    worker.translation_model,
                    worker.translation_model,
                    translation_contract,
                    "coordinator-medium:helper-high",
                    "whole-source-logic-v2"
                ]))?);
                let mut item = unit(
                    format!("pseudo:{}", source.hash),
                    format!(
                        "{} · lines {}–{}",
                        source.path, part.start_line, part.end_line
                    ),
                    PreparationPhase::Pseudocode,
                    json!({"fileId":source_files.get(&source.source_id),"file":source.path,"sourceId":source.source_id,"hash":source.hash,"segment":{"startLine":1,"endLine":segment.end_line,"text":if segment.text.len() <= 64 * 1024 { Some(segment.text.clone()) } else { None }},"readFromManifest":segment.text.len() > 64 * 1024,"format":format}),
                    Kind::Translation(segment),
                );
                item.bindings[0].offset = part.start_line - 1;
                item.cache_key = Some(key.clone());
                registered.insert(item.key.clone(), PreparationPhase::Pseudocode);
                items.push(item.clone());
                if let Some(existing) = dedup.get_mut(&key) {
                    existing.bindings.extend(item.bindings);
                } else {
                    dedup.insert(key, item);
                }
            }
            translations.insert(source.hash.clone(), items);
        }
        let mut queue = translation_groups(dedup.into_values().collect());
        let mut tasks = JoinSet::new();
        let mut expanded = false;
        let mut fatal = None;
        self.update(|state| {
            state.phase = PreparationPhase::Outline;
        });
        loop {
            while let Ok(completed) = rx.try_recv() {
                if let Err(error) = self.record(completed, cache).await {
                    fatal = Some(error);
                    break;
                }
            }
            if !expanded && let Some(value) = self.checkpoint.results.get("outline").cloned() {
                let outline: Outline = serde_json::from_value(value)?;
                validate_outline(&outline, &workspace.snapshot)?;
                let mut documents = Vec::new();
                for (ti, topic) in outline.topics.iter().enumerate() {
                    for (si, step) in topic.steps.iter().enumerate() {
                        let relevant: Vec<_> = sources
                            .iter()
                            .filter(|source| {
                                step.anchors.iter().any(|a| {
                                    source
                                        .source_id
                                        .starts_with(&format!("change:{}:", a.change_id))
                                })
                            })
                            .collect();
                        let evidence = document_evidence(&relevant, &inline_sources);
                        documents.push(unit(format!("step:{ti}:{si}"),step.title.clone(),PreparationPhase::Documents,json!({"scope":"readingStep","topic":topic.title,"brief":topic.brief,"step":step,"sources":relevant,"capturedSources":evidence}),Kind::Documents));
                    }
                }
                for document in &documents {
                    registered.insert(document.key.clone(), document.phase.clone());
                }
                // Interleave documents with already queued translations; neither category starves.
                let mut docs = group(documents, 2);
                let mut combined = VecDeque::new();
                while !docs.is_empty() || !queue.is_empty() {
                    if let Some(job) = docs.pop_front() {
                        combined.push_back(job)
                    }
                    if let Some(job) = queue.pop_front() {
                        combined.push_back(job)
                    }
                }
                queue = combined;
                let titles = outline
                    .topics
                    .iter()
                    .flat_map(|t| t.steps.iter().map(|s| s.title.clone()))
                    .collect();
                self.update(|state| state.step_titles = titles);
                expanded = true;
            }
            while let Some(result) = tasks.try_join_next() {
                match result {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => {
                        fatal = Some(error);
                    }
                    Err(error) => {
                        fatal = Some(AppError::new("task", error.to_string()));
                    }
                }
            }
            if self.cancel.load(Ordering::Relaxed) && fatal.is_none() {
                fatal = Some(AppError::new(
                    "cancelled",
                    "Preparation stopped. Completed results can be resumed.",
                ));
            }
            if fatal.is_some() {
                self.cancel.store(true, Ordering::Relaxed);
                tasks.abort_all();
                while tasks.join_next().await.is_some() {}
                while let Ok(completed) = rx.try_recv() {
                    self.record(completed, cache).await?;
                }
                break;
            }
            while tasks.len() < MAX_COORDINATORS
                && let Some(job) = queue.pop_front()
            {
                let mut pending = Vec::new();
                for item in job {
                    let mut value = None;
                    for binding in &item.bindings {
                        if let Some(old) = self.checkpoint.results.get(&binding.key) {
                            let candidate = if matches!(item.kind, Kind::Translation(_))
                                && old.get("unavailable").is_none()
                            {
                                rebase(old, binding.offset, true)?
                            } else {
                                old.clone()
                            };
                            if candidate.get("unavailable").is_some()
                                || item.validate(&candidate, workspace, &self.storage).is_ok()
                            {
                                value = Some(candidate);
                                break;
                            }
                        }
                    }
                    if value.is_none()
                        && let Some(key) = &item.cache_key
                    {
                        let cache = cache.clone();
                        let key = key.clone();
                        let candidate = tokio::task::spawn_blocking(move || cache.get(&key))
                            .await
                            .map_err(|e| AppError::new("task", e.to_string()))??;
                        if let Some(candidate) = candidate
                            && item.validate(&candidate, workspace, &self.storage).is_ok()
                        {
                            value = Some(candidate);
                        }
                    }
                    if let Some(value) = value {
                        worker
                            .completed
                            .send(Completed { unit: item, value })
                            .map_err(|_| state_error())?;
                    } else {
                        pending.push(item);
                    }
                }
                if !pending.is_empty() {
                    let worker = worker.clone();
                    tasks.spawn(async move { worker.work(pending).await });
                }
            }
            let mut phases = Vec::new();
            for phase in [
                PreparationPhase::Outline,
                PreparationPhase::Documents,
                PreparationPhase::Pseudocode,
            ] {
                let keys: Vec<_> = registered
                    .iter()
                    .filter(|(_, p)| **p == phase)
                    .map(|(k, _)| k)
                    .collect();
                phases.push(PreparationPhaseCount {
                    phase,
                    total: keys.len() as u32,
                    completed: keys
                        .iter()
                        .filter(|key| self.checkpoint.results.contains_key(**key))
                        .count() as u32,
                });
            }
            self.update(|state| {
                state.phase = phases
                    .iter()
                    .find(|phase| phase.completed < phase.total)
                    .map(|phase| phase.phase.clone())
                    .unwrap_or(PreparationPhase::Checking);
                state.total_batches = registered.len() as u32;
                state.completed_batches = phases.iter().map(|p| p.completed).sum();
                state.phases = phases;
            });
            if tasks.is_empty() && queue.is_empty() && rx.is_empty() && expanded {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        self.persist().await?;
        if let Some(error) = fatal {
            return Err(error);
        }
        self.check_cancel()?;
        let outline: Outline = serde_json::from_value(self.checkpoint.results["outline"].clone())?;
        let selected = outline.translation_files.clone();
        let mut topics = Vec::new();
        for (ti, topic) in outline.topics.into_iter().enumerate() {
            let mut steps = Vec::new();
            for (si, step) in topic.steps.into_iter().enumerate() {
                steps.push(Step {
                    id: format!("{}-step-{ti}-{si}", self.checkpoint.state.id),
                    title: step.title,
                    anchors: step.anchors,
                    documents: serde_json::from_value(
                        self.checkpoint.results[&format!("step:{ti}:{si}")].clone(),
                    )?,
                });
            }
            topics.push(Topic {
                id: format!("{}-topic-{ti}", self.checkpoint.state.id),
                title: topic.title,
                brief: topic.brief,
                steps,
            });
        }
        let mut contents = Vec::new();
        for file in files {
            let pseudocode_selected = selected.contains(&file.id);
            let mut translated = Vec::new();
            for source in sources.iter().filter(|s| {
                pseudocode_selected
                    && file
                        .change_ids
                        .iter()
                        .any(|id| s.source_id.starts_with(&format!("change:{id}:")))
            }) {
                let mut blocks = Vec::new();
                let mut reason = unavailable.get(&source.hash).cloned();
                for item in translations.get(&source.hash).into_iter().flatten() {
                    let value = &self.checkpoint.results[&item.key];
                    if let Some(error) = value["unavailable"].as_str() {
                        reason = Some(error.into());
                        break;
                    }
                    let result: TranslationResult = serde_json::from_value(value.clone())?;
                    blocks.extend(result.blocks);
                }
                if reason.is_some() {
                    blocks.clear();
                }
                translated.push(PseudoTranslation {
                    source_id: source.source_id.clone(),
                    source_hash: source.hash.clone(),
                    blocks,
                    unavailable_reason: reason,
                });
            }
            contents.push(ReviewFileContent {
                pseudocode_skip_reason: None,
                pseudocode_selected: Some(pseudocode_selected),
                file_id: file.id,
                documents: None,
                translations: translated,
            });
        }
        self.update(|state| state.phase = PreparationPhase::Checking);
        self.persist().await?;
        self.check_cancel()?;
        let storage = self.storage.clone();
        let state = self.checkpoint.state.clone();
        let revision = self.checkpoint.review_revision;
        tokio::task::spawn_blocking(move || {
            reader::publish_preparation(
                &storage,
                &state.review_id,
                &state.snapshot_id,
                &state.id,
                revision,
                topics,
                contents,
            )
        })
        .await
        .map_err(|e| AppError::new("task", e.to_string()))??;
        Ok(())
    }
    async fn record(&mut self, completed: Completed, cache: &TranslationCache) -> AppResult<()> {
        let value = completed.value;
        if let Some(key) = &completed.unit.cache_key
            && value.get("unavailable").is_none()
        {
            let cache = cache.clone();
            let key = key.clone();
            let value = value.clone();
            tokio::task::spawn_blocking(move || cache.put(&key, &value))
                .await
                .map_err(|e| AppError::new("task", e.to_string()))??;
        }
        for binding in completed.unit.bindings {
            let result = if matches!(completed.unit.kind, Kind::Translation(_))
                && value.get("unavailable").is_none()
            {
                rebase(&value, binding.offset, false)?
            } else {
                value.clone()
            };
            self.checkpoint.results.insert(binding.key, result);
        }
        self.persist().await
    }
}

#[cfg(all(test, unix))]
mod tests;
