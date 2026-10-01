//! One owner reconciles streamed definitions, jobs and durable results.
use super::*;
use tokio::task::JoinSet;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Candidate {
    pub topic: OutlineTopic,
    pub order: (usize, usize),
}
impl Candidate {
    fn step(&self) -> &OutlineStep {
        &self.topic.steps[0]
    }
    fn key(&self) -> String {
        format!("step:{}", self.step().draft_id)
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::preparation) struct Definition {
    candidate: Candidate,
    version: u64,
    fingerprint: String,
    confirmed: bool,
    reused: bool,
}
struct Scheduler {
    worker: Worker,
    sources: Vec<SourceDescriptor>,
    baseline: Option<Workspace>,
    signature: String,
    seen: HashSet<String>,
    jobs: BTreeMap<(String, u64), Arc<AtomicBool>>,
    tasks: JoinSet<(String, u64, AppResult<()>)>,
    queue: VecDeque<Unit>,
    failures: BTreeMap<(String, u64), AppError>,
    inline: BTreeMap<String, String>,
    confirmed: bool,
}

pub(super) async fn schedule(
    run: &mut Run,
    worker: &Worker,
    sources: &[SourceDescriptor],
    baseline: Option<Workspace>,
    signature: &str,
    rx: &mut mpsc::UnboundedReceiver<WorkUpdate>,
) -> AppResult<HashSet<String>> {
    let mut scheduler = Scheduler {
        worker: worker.clone(),
        sources: sources.to_vec(),
        baseline,
        signature: signature.into(),
        seen: HashSet::new(),
        jobs: BTreeMap::new(),
        tasks: JoinSet::new(),
        queue: VecDeque::new(),
        failures: BTreeMap::new(),
        inline: BTreeMap::new(),
        confirmed: false,
    };
    let result = scheduler.drive(run, rx).await;
    // Never abort the Rust futures: transports must finish killing their owned
    // process groups before permits are released or the runtime is reused.
    for cancel in scheduler.jobs.values() {
        cancel.store(true, Ordering::Relaxed);
    }
    while scheduler.tasks.join_next().await.is_some() {}
    // Valid results already delivered before a failure/cancellation remain useful
    // on explicit resume. Never install a late obsolete version or an outline here.
    while let Ok(update) = rx.try_recv() {
        if let WorkUpdate::Completed(completed) = update
            && matches!(completed.unit.kind, Kind::Documents)
            && scheduler.current(run, &completed.unit.key, completed.unit.version)
        {
            run.record(completed).await?;
        }
    }
    result
}
impl Scheduler {
    fn spawn(&mut self, unit: Unit) {
        self.queue.push_back(unit);
    }
    fn launch(&mut self, unit: Unit) {
        let key = unit.key.clone();
        let version = unit.version;
        let mut worker = self.worker.clone();
        worker.cancel = Arc::new(AtomicBool::new(false));
        self.jobs
            .insert((key.clone(), version), worker.cancel.clone());
        self.tasks
            .spawn(async move { (key, version, worker.work(vec![unit]).await) });
    }
    fn current(&self, run: &Run, key: &str, version: u64) -> bool {
        key == "outline"
            || (self.seen.contains(key)
                && run
                    .checkpoint
                    .definitions
                    .get(key)
                    .is_some_and(|definition| definition.version == version))
    }
    fn stop(&self, key: &str) {
        for ((id, _), cancel) in &self.jobs {
            if id == key {
                cancel.store(true, Ordering::Relaxed);
            }
        }
    }
    async fn drive(
        &mut self,
        run: &mut Run,
        rx: &mut mpsc::UnboundedReceiver<WorkUpdate>,
    ) -> AppResult<HashSet<String>> {
        if let Some(old) = &self.baseline {
            self.worker
                .glossary
                .lock()
                .map_err(|_| state_error())?
                .insert("previous-review".into(), old.review.glossary.clone());
        }
        let outline = unit(
            "outline".into(),
            "Organizing the reading path".into(),
            PreparationPhase::Outline,
            json!({"sources": self.sources, "files":reader::files(&self.worker.workspace.snapshot),
                "previousDefinitions":run.checkpoint.definitions.values().map(|d| &d.candidate).collect::<Vec<_>>(),
                "previousReview":self.baseline.as_ref().map(|old|json!({"id":old.review.id,"topics":old.review.topics.iter().map(|t|json!({"id":t.id,"title":t.title,"brief":t.brief,"steps":t.steps.iter().map(|s|json!({"id":s.id,"title":s.title,"anchors":s.anchors})).collect::<Vec<_>>()})).collect::<Vec<_>>()})),
                "comparison":self.baseline.as_ref().map(|old|adaptation::comparison(&old.snapshot,&self.worker.workspace.snapshot))}),
            if self.baseline.is_some() {
                Kind::Adaptation
            } else {
                Kind::Outline
            },
        );
        run.update(|state| {
            state.phase = PreparationPhase::Outline;
            state.steps.clear();
        });
        if let Some(value) = run.checkpoint.results.get("outline").cloned() {
            outline.validate(&value, &self.worker.workspace, &run.storage)?;
            self.confirm(run, serde_json::from_value(value)?).await?;
        } else {
            self.spawn(outline);
        }
        loop {
            run.check_cancel()?;
            while let Ok(update) = rx.try_recv() {
                match update {
                    WorkUpdate::Preview(candidates) if !self.confirmed => {
                        // A partial retry never removes prior definitions. Ambiguous
                        // duplicate identities wait for the authoritative correction.
                        let mut counts = BTreeMap::new();
                        for c in &candidates {
                            *counts.entry(c.key()).or_insert(0) += 1;
                        }
                        for candidate in candidates {
                            if counts[&candidate.key()] == 1 {
                                self.upsert(run, candidate).await?;
                            }
                        }
                    }
                    WorkUpdate::Preview(_) => {}
                    WorkUpdate::Status(key, version, status) => {
                        if self.current(run, &key, version) {
                            run.update(|state| {
                                if let Some(step) = state.steps.iter_mut().find(|s| s.id == key)
                                    && step.status != PreparationStepStatus::Ready
                                {
                                    step.status = status;
                                }
                            });
                        }
                    }
                    WorkUpdate::Completed(completed) => {
                        if !self.current(run, &completed.unit.key, completed.unit.version) {
                            continue;
                        }
                        if completed.unit.key == "outline" {
                            self.confirm(run, serde_json::from_value(completed.value.clone())?)
                                .await?;
                        } else {
                            self.remember_glossary(&completed)?;
                        }
                        run.record(completed).await?;
                    }
                }
            }
            while let Some(result) = self.tasks.try_join_next() {
                let (key, version, outcome) =
                    result.map_err(|e| AppError::new("task", e.to_string()))?;
                self.jobs.remove(&(key.clone(), version));
                if self.current(run, &key, version)
                    && let Err(error) = outcome
                {
                    if key == "outline" || error.code != "invalid_preparation" {
                        return Err(error);
                    }
                    run.update(|state| {
                        if let Some(step) = state.steps.iter_mut().find(|s| s.id == key) {
                            step.status = PreparationStepStatus::Failed;
                        }
                    });
                    self.failures.insert((key, version), error);
                }
            }
            if self.confirmed {
                let failed = self
                    .failures
                    .keys()
                    .find(|(key, version)| self.current(run, key, *version))
                    .cloned();
                if let Some(key) = failed {
                    return Err(self.failures.remove(&key).expect("known failure"));
                }
            }
            while self.tasks.len() < MAX_COORDINATORS
                && let Some(unit) = self.queue.pop_front()
            {
                if self.current(run, &unit.key, unit.version) {
                    self.launch(unit);
                }
            }
            self.counts(run);
            if self.confirmed && self.tasks.is_empty() && self.queue.is_empty() && rx.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        run.persist().await?;
        Ok(run
            .checkpoint
            .definitions
            .values()
            .filter(|d| d.reused)
            .filter_map(|d| d.candidate.step().previous_step_id.clone())
            .collect())
    }
    fn remember_glossary(&self, completed: &Completed) -> AppResult<()> {
        let docs: LevelDocuments = serde_json::from_value(completed.value.clone())?;
        self.worker
            .glossary
            .lock()
            .map_err(|_| state_error())?
            .insert(
                completed.unit.key.clone(),
                docs.glossary
                    .iter()
                    .chain(&docs.essential.terms)
                    .chain(&docs.explained.terms)
                    .chain(&docs.technical.terms)
                    .cloned()
                    .collect(),
            );
        Ok(())
    }
    async fn confirm(&mut self, run: &mut Run, outline: Outline) -> AppResult<()> {
        let keys: HashSet<_> = outline
            .topics
            .iter()
            .flat_map(|t| &t.steps)
            .map(|s| format!("step:{}", s.draft_id))
            .collect();
        for key in run
            .checkpoint
            .definitions
            .keys()
            .filter(|k| !keys.contains(*k))
            .cloned()
            .collect::<Vec<_>>()
        {
            self.stop(&key);
            run.checkpoint.definitions.remove(&key);
            run.checkpoint.results.remove(&key);
            self.worker
                .glossary
                .lock()
                .map_err(|_| state_error())?
                .remove(&key);
            self.seen.remove(&key);
        }
        for (ti, topic) in outline.topics.iter().enumerate() {
            for (si, step) in topic.steps.iter().enumerate() {
                self.upsert(
                    run,
                    Candidate {
                        topic: OutlineTopic {
                            title: topic.title.clone(),
                            brief: topic.brief.clone(),
                            steps: vec![step.clone()],
                        },
                        order: (ti, si),
                    },
                )
                .await?;
            }
        }
        for definition in run.checkpoint.definitions.values_mut() {
            definition.confirmed = true;
        }
        self.confirmed = true;
        self.rows(run);
        if self.baseline.is_some() {
            let retained = run
                .checkpoint
                .definitions
                .values()
                .filter(|d| d.reused)
                .count() as u32;
            let rewritten = run
                .checkpoint
                .definitions
                .values()
                .filter(|d| !d.reused && d.candidate.step().previous_step_id.is_some())
                .count() as u32;
            let added = run.checkpoint.definitions.len() as u32 - retained - rewritten;
            run.update(|state| {
                if let Some(u) = &mut state.adaptation {
                    u.retained_steps = retained;
                    u.rewritten_steps = rewritten;
                    u.added_steps = added;
                    u.removed_steps = outline.removed_steps.len() as u32;
                }
            });
        }
        run.persist().await
    }
    async fn upsert(&mut self, run: &mut Run, candidate: Candidate) -> AppResult<()> {
        run.check_cancel()?;
        let key = candidate.key();
        // Order is deliberately outside the signature; captured inputs and the
        // generation configuration are inside it, including supplemental sources.
        let hash = fingerprint(&serde_json::to_vec(&json!([
            candidate.topic,
            self.signature,
            run.checkpoint.source_hash
        ]))?);
        let old = run.checkpoint.definitions.get(&key).cloned();
        let unchanged = old.as_ref().is_some_and(|d| d.fingerprint == hash);
        let first = self.seen.insert(key.clone());
        if unchanged && !first {
            run.checkpoint
                .definitions
                .get_mut(&key)
                .expect("known definition")
                .candidate = candidate;
            self.rows(run);
            return Ok(());
        }
        let version = old
            .as_ref()
            .map_or(1, |d| d.version + u64::from(!unchanged));
        if !unchanged {
            self.stop(&key);
            run.checkpoint.results.remove(&key);
            self.worker
                .glossary
                .lock()
                .map_err(|_| state_error())?
                .remove(&key);
            run.update(|s| {
                if let Some(step) = s.steps.iter_mut().find(|s| s.id == key) {
                    step.status = PreparationStepStatus::Queued;
                }
            });
        }
        let mut reused = false;
        let mut value = run.checkpoint.results.get(&key).cloned();
        if value.is_none()
            && let Some(old) = &self.baseline
            && let Some(docs) = adaptation::reuse_documents(
                old,
                &self.worker.workspace.snapshot,
                &candidate.topic,
                candidate.step(),
                &self.signature,
            )
            && validate_documents(&docs, &self.worker.workspace.snapshot, &run.storage).is_ok()
        {
            value = Some(serde_json::to_value(docs)?);
            reused = true;
        } else if unchanged {
            reused = old.as_ref().is_some_and(|d| d.reused);
        }
        run.checkpoint.definitions.insert(
            key.clone(),
            Definition {
                candidate: candidate.clone(),
                version,
                fingerprint: hash,
                confirmed: self.confirmed,
                reused,
            },
        );
        self.rows(run);
        run.persist().await?;
        self.evidence(run, candidate.step()).await?;
        let mut document = unit(
            key.clone(),
            candidate.step().title.clone(),
            PreparationPhase::Documents,
            document_input(
                &candidate.topic,
                candidate.step(),
                &self.sources,
                &self.inline,
            ),
            Kind::Documents,
        );
        document.version = version;
        if let Some(value) = value.filter(|v| {
            document
                .validate(v, &self.worker.workspace, &run.storage)
                .is_ok()
        }) {
            let completed = Completed {
                unit: document,
                value,
            };
            self.remember_glossary(&completed)?;
            run.record(completed).await?;
        } else {
            run.checkpoint.results.remove(&key);
            self.spawn(document);
        }
        Ok(())
    }
    async fn evidence(&mut self, run: &Run, step: &OutlineStep) -> AppResult<()> {
        let mut remaining = 64 * 1024;
        for source in self.sources.iter().filter(|s| {
            step.context_source_ids.contains(&s.source_id)
                || step
                    .anchors
                    .iter()
                    .any(|a| s.source_id.starts_with(&format!("change:{}:", a.change_id)))
        }) {
            run.check_cancel()?;
            if source.size > remaining {
                continue;
            }
            remaining -= source.size;
            if self.inline.contains_key(&source.hash) {
                continue;
            }
            let storage = run.storage.clone();
            let snapshot = self.worker.workspace.snapshot.clone();
            let id = source.source_id.clone();
            let frozen =
                tokio::task::spawn_blocking(move || reader::source(&storage, &snapshot, &id))
                    .await
                    .map_err(|e| AppError::new("task", e.to_string()))??;
            if let Some(text) = frozen.text {
                self.inline.insert(source.hash.clone(), text);
            }
        }
        Ok(())
    }
    fn rows(&self, run: &Run) {
        let mut definitions: Vec<_> = run
            .checkpoint
            .definitions
            .iter()
            .filter(|(key, _)| self.seen.contains(*key))
            .collect();
        definitions.sort_by_key(|(_, d)| d.candidate.order);
        run.update(|state| {
            state.steps = definitions
                .iter()
                .map(|(key, d)| PreparationStep {
                    id: (*key).clone(),
                    title: d.candidate.step().title.clone(),
                    status: state
                        .steps
                        .iter()
                        .find(|s| s.id == **key)
                        .map_or(PreparationStepStatus::Queued, |s| s.status.clone()),
                })
                .collect();
        });
    }
    fn counts(&self, run: &Run) {
        let completed = self
            .seen
            .iter()
            .filter(|k| run.checkpoint.results.contains_key(*k))
            .count() as u32;
        let phases = vec![
            PreparationPhaseCount {
                phase: PreparationPhase::Outline,
                total: 1,
                completed: u32::from(self.confirmed),
            },
            PreparationPhaseCount {
                phase: PreparationPhase::Documents,
                total: self.seen.len() as u32,
                completed,
            },
        ];
        run.update(|s| {
            s.phase = if !self.confirmed {
                PreparationPhase::Outline
            } else if completed < self.seen.len() as u32 {
                PreparationPhase::Documents
            } else {
                PreparationPhase::Checking
            };
            s.total_batches = 1 + self.seen.len() as u32;
            s.completed_batches = completed + u32::from(self.confirmed);
            s.phases = phases;
        });
    }
}
