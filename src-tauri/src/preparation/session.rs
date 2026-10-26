//! Agent-owned document plan. Every acknowledged mutation is checkpointed by Run.
use super::*;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Draft {
    pub revision: u32,
    pub profile: ReviewWritingProfile,
    pub planned: bool,
    pub steps: Vec<PlannedStep>,
    pub documents: BTreeMap<String, LevelDocuments>,
    pub decisions: BTreeMap<String, String>,
    pub receipts: BTreeMap<String, (String, Value)>,
    #[serde(default)]
    pub journal: Vec<Value>,
    #[serde(default)]
    pub activity: BTreeMap<String, PreparationStepStatus>,
    #[serde(default)]
    pub removed: BTreeMap<String, String>,
    pub finished: bool,
    pub summary: String,
}
#[derive(Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PlannedStep {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub previous_step_id: Option<String>,
    #[serde(default)]
    pub anchors: Vec<CodeAnchor>,
    #[serde(default)]
    pub context_source_ids: Vec<String>,
}
impl Draft {
    pub(super) fn call(
        &mut self,
        name: &str,
        args: Value,
        storage: &Storage,
        workspace: &Workspace,
        baseline: Option<&Workspace>,
    ) -> AppResult<Value> {
        let key = args["requestId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| invalid("A stable requestId is required."))?;
        let hash = fingerprint(&serde_json::to_vec(&(name, &args))?);
        if let Some((previous, result)) = self.receipts.get(key) {
            if previous != &hash {
                return Err(invalid(
                    "This requestId was already used with different arguments.",
                ));
            }
            return Ok(result.clone());
        }
        if args["revision"].as_u64() != Some(self.revision as u64) {
            return Err(invalid(
                "The draft revision changed. Read the current state before retrying.",
            ));
        }
        if self.finished {
            return Err(invalid("This preparation is already finished."));
        }
        let mut next = self.clone();
        match name {
            "review_plan" => {
                let steps: Vec<PlannedStep> = serde_json::from_value(args["steps"].clone())?;
                let mut ids = HashSet::new();
                let mut previous_ids = HashSet::new();
                let mut final_ids = HashSet::new();
                for step in &steps {
                    if !final_ids.insert(step.previous_step_id.as_ref().unwrap_or(&step.id)) {
                        return Err(invalid("The plan produces duplicate document identities."));
                    }
                    if (step.id.is_empty()
                        || step.id.len() > 100
                        || !step
                            .id
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"-_:".contains(&b)))
                        || step.title.trim().is_empty()
                        || !ids.insert(step.id.clone())
                    {
                        return Err(invalid("Plan steps need distinct stable IDs and titles."));
                    }
                    if let Some(previous) = &step.previous_step_id
                        && (!previous_ids.insert(previous.clone())
                            || !old_steps(baseline).iter().any(|s| &s.id == previous))
                    {
                        return Err(invalid("Unknown or duplicate previousStepId."));
                    }
                }
                for step in &self.steps {
                    if !ids.contains(&step.id)
                        && self.decisions.get(&step.id).map(String::as_str) != Some("remove")
                    {
                        return Err(invalid(
                            "Explicitly remove a step before omitting it from the plan.",
                        ));
                    }
                }
                for step in &steps {
                    if let Some(old) = self.steps.iter().find(|old| old.id == step.id)
                        && serde_json::to_value(old)? != serde_json::to_value(step)?
                    {
                        next.documents.remove(&step.id);
                        next.decisions.remove(&step.id);
                    }
                }
                next.steps = steps;
                next.planned = true;
            }
            "review_document" => {
                if !self.planned {
                    return Err(invalid("Announce the document plan before writing."));
                }
                let id = args["stepId"]
                    .as_str()
                    .ok_or_else(|| invalid("stepId is required."))?;
                let step = next
                    .steps
                    .iter_mut()
                    .find(|s| s.id == id)
                    .ok_or_else(|| invalid("Unknown planned step."))?;
                step.anchors = serde_json::from_value(args["anchors"].clone())?;
                step.context_source_ids = serde_json::from_value(
                    args.get("contextSourceIds").cloned().unwrap_or(json!([])),
                )?;
                validate_step(step, &workspace.snapshot)?;
                let content: ReviewDocument = serde_json::from_value(args["document"].clone())?;
                let mut documents = LevelDocuments {
                    single: Some(SingleReviewDocument {
                        version: 1,
                        profile: self.profile.clone(),
                        content,
                    }),
                    ..Default::default()
                };
                reader::estimate_reading_time(&mut documents);
                documents = reader::glossary::canonicalize(documents);
                reader::validate_documents(storage, &workspace.snapshot, &documents)?;
                adaptation::attach_dependencies(
                    &mut documents,
                    &step.anchors,
                    &step.context_source_ids,
                    &workspace.snapshot,
                    "agent-session-v1",
                )?;
                next.removed.remove(id);
                next.documents.insert(id.into(), documents);
                next.decisions.insert(
                    id.into(),
                    if step.previous_step_id.is_some() {
                        "modify"
                    } else {
                        "add"
                    }
                    .into(),
                );
            }
            "review_decide" => {
                let id = args["stepId"]
                    .as_str()
                    .ok_or_else(|| invalid("stepId is required."))?;
                match args["decision"].as_str() {
                    Some("remove") => {
                        if !self.steps.iter().any(|s| s.id == id)
                            && !old_steps(baseline).iter().any(|s| s.id == id)
                        {
                            return Err(invalid("Unknown step."));
                        }
                        let title = self
                            .steps
                            .iter()
                            .find(|s| s.id == id)
                            .map(|s| s.title.clone())
                            .or_else(|| {
                                old_steps(baseline)
                                    .iter()
                                    .find(|s| s.id == id)
                                    .map(|s| s.title.clone())
                            })
                            .unwrap_or_else(|| id.into());
                        next.removed.insert(id.into(), title);
                        next.decisions.insert(id.into(), "remove".into());
                        next.documents.remove(id);
                    }
                    Some("keep") => {
                        let step = next
                            .steps
                            .iter_mut()
                            .find(|s| s.id == id)
                            .ok_or_else(|| invalid("Unknown planned step."))?;
                        let source = baseline.ok_or_else(|| invalid("No previous review."))?;
                        let previous = old_steps(Some(source))
                            .into_iter()
                            .find(|s| Some(&s.id) == step.previous_step_id.as_ref())
                            .ok_or_else(|| invalid("A retained step needs previousStepId."))?;
                        let (anchors, documents) = retained(
                            source,
                            &workspace.snapshot,
                            previous,
                            &self.profile,
                        )
                        .ok_or_else(|| {
                            invalid(
                                "This document or its dependencies are stale; rewrite it instead.",
                            )
                        })?;
                        if step.title != previous.title {
                            return Err(invalid("A renamed step must be rewritten."));
                        }
                        step.anchors = anchors;
                        next.documents.insert(id.into(), documents);
                        next.decisions.insert(id.into(), "keep".into());
                    }
                    _ => return Err(invalid("decision must be keep or remove.")),
                }
            }
            "review_finish" => {
                if !self.planned {
                    return Err(invalid("Declare the plan before finishing."));
                }
                for step in &self.steps {
                    if self.decisions.get(&step.id).map(String::as_str) == Some("remove") {
                        continue;
                    }
                    validate_step(step, &workspace.snapshot)?;
                    let documents = self
                        .documents
                        .get(&step.id)
                        .ok_or_else(|| invalid("A planned document is missing."))?;
                    reader::validate_documents(storage, &workspace.snapshot, documents)?;
                }
                for old in old_steps(baseline) {
                    if !self.steps.iter().any(|s| {
                        s.previous_step_id.as_ref() == Some(&old.id)
                            && self.decisions.contains_key(&s.id)
                    }) && self.decisions.get(&old.id).map(String::as_str) != Some("remove")
                    {
                        return Err(invalid(
                            "Every previous document needs an explicit keep, modify or remove decision.",
                        ));
                    }
                }
                next.summary = args["summary"].as_str().unwrap_or_default().into();
                next.finished = true;
            }
            _ => return Err(invalid("Unknown preparation mutation.")),
        }
        next.revision += 1;
        let result = json!({"revision":next.revision,"finished":next.finished});
        next.journal.push(json!({"sequence":next.revision,"tool":name,"requestId":key,"fingerprint":hash,"at":now()}));
        next.receipts.insert(key.into(), (hash, result.clone()));
        *self = next;
        Ok(result)
    }
    pub(super) fn progress(&self) -> Vec<PreparationStep> {
        self.steps
            .iter()
            .map(|step| {
                let decision = self.decisions.get(&step.id).cloned();
                PreparationStep {
                    id: step.id.clone(),
                    title: step.title.clone(),
                    status: if decision.as_deref() == Some("remove") {
                        PreparationStepStatus::Removed
                    } else if self.documents.contains_key(&step.id) {
                        PreparationStepStatus::Ready
                    } else {
                        self.activity
                            .get(&step.id)
                            .cloned()
                            .unwrap_or(PreparationStepStatus::Queued)
                    },
                    decision,
                }
            })
            .chain(
                self.removed
                    .iter()
                    .filter(|(id, _)| !self.steps.iter().any(|s| &s.id == *id))
                    .map(|(id, title)| PreparationStep {
                        id: id.clone(),
                        title: title.clone(),
                        status: PreparationStepStatus::Removed,
                        decision: Some("remove".into()),
                    }),
            )
            .collect()
    }
    pub(super) fn topics(&self) -> Vec<Topic> {
        self.steps
            .iter()
            .filter(|s| self.decisions.get(&s.id).map(String::as_str) != Some("remove"))
            .filter_map(|s| {
                self.documents.get(&s.id).map(|documents| Topic {
                    id: format!("topic-{}", s.id),
                    title: s.title.clone(),
                    brief: s.title.clone(),
                    steps: vec![Step {
                        id: s.previous_step_id.clone().unwrap_or_else(|| s.id.clone()),
                        title: s.title.clone(),
                        anchors: s.anchors.clone(),
                        documents: documents.clone(),
                    }],
                })
            })
            .collect()
    }
}
fn validate_step(step: &PlannedStep, snapshot: &Snapshot) -> AppResult<()> {
    if step.anchors.is_empty() {
        return Err(invalid(
            "A document needs captured anchors for human review.",
        ));
    }
    for a in &step.anchors {
        if a.snapshot_id != snapshot.id
            || !snapshot
                .changes
                .iter()
                .any(|c| c.id == a.change_id && c.passages.iter().any(|p| p.id == a.passage_id))
        {
            return Err(invalid("An anchor is outside this capture."));
        }
    }
    let sources = reader::sources(snapshot);
    if step
        .context_source_ids
        .iter()
        .any(|id| !sources.iter().any(|s| &s.source_id == id))
    {
        return Err(invalid("Unknown context source."));
    }
    Ok(())
}
fn old_steps(baseline: Option<&Workspace>) -> Vec<&Step> {
    baseline
        .into_iter()
        .flat_map(|w| w.review.topics.iter().flat_map(|t| &t.steps))
        .collect()
}
fn retained(
    source: &Workspace,
    target: &Snapshot,
    step: &Step,
    profile: &ReviewWritingProfile,
) -> Option<(Vec<CodeAnchor>, LevelDocuments)> {
    let mapping = adaptation::source_map(&source.snapshot, target);
    let anchors = adaptation::mapped_anchors(&source.snapshot, target, &step.anchors)?;
    let mut documents = step.documents.clone();
    documents.glossary = source.review.glossary.clone();
    if documents
        .single
        .as_ref()
        .map(|s| &s.profile)
        .unwrap_or(&ReviewWritingProfile::default())
        != profile
    {
        return None;
    }
    if let Some(dependencies) = &documents.dependencies {
        let sources = reader::sources(target);
        if dependencies.sources.iter().any(|s| {
            !sources.iter().any(|n| {
                mapping.get(&s.source_id) == Some(&n.source_id)
                    && s.hash == n.hash
                    && s.path == n.path
            })
        }) {
            return None;
        }
    }
    // Historical reviews have one visible Essential document in the new reader.
    if documents.single.is_none() {
        documents.single = Some(SingleReviewDocument {
            version: 1,
            profile: profile.clone(),
            content: documents.essential.clone(),
        });
        documents.essential = ReviewDocument::default();
        documents.explained = ReviewDocument::default();
        documents.technical = ReviewDocument::default();
    }
    for doc in documents.documents_mut() {
        for reference in &mut doc.references {
            reference.source_id = mapping.get(&reference.source_id)?.clone();
        }
    }
    documents.context_sources = documents
        .context_sources
        .iter()
        .map(|s| mapping.get(s).cloned())
        .collect::<Option<Vec<_>>>()?;
    if let Some(dependencies) = &mut documents.dependencies {
        for source in &mut dependencies.sources {
            source.source_id = mapping.get(&source.source_id)?.clone();
        }
    }
    Some((anchors, documents))
}

impl Run {
    pub(super) async fn execute_session(
        &mut self,
        workspace: Workspace,
        config: ProviderConfig,
        language: String,
    ) -> AppResult<()> {
        let baseline = self
            .checkpoint
            .state
            .adaptation
            .as_ref()
            .map(|u| reviews::load(&self.storage, &u.source_review_id))
            .transpose()?;
        let mut draft: Draft = match self.checkpoint.results.get("session") {
            Some(value) => serde_json::from_value(value.clone())?,
            None => Draft {
                profile: writing::effective(&self.storage, &workspace.review.repository_id)?,
                ..Default::default()
            },
        };
        if draft.finished {
            return self.install_session(workspace, &draft).await;
        }
        let template = std::fs::read_to_string(self.resources.join("preparation/session.md"))?;
        let source_hash = fingerprint(&serde_json::to_vec(&workspace.snapshot)?);
        let prompt_hash = fingerprint(template.as_bytes());
        let provider_hash = fingerprint(&serde_json::to_vec(&config)?);
        compatible(&self.checkpoint, &source_hash, &prompt_hash, &provider_hash)?;
        self.checkpoint.source_hash = source_hash;
        self.checkpoint.prompt_hash = prompt_hash;
        self.checkpoint.provider_hash = provider_hash;
        let runtime = agents::PreparationRuntime::new(
            self.storage.clone(),
            workspace.clone(),
            config.clone(),
            self.cancel.clone(),
            baseline.clone(),
        )
        .await?;
        let (bridge, mut calls) = super::bridge::Bridge::start().await?;
        let manager = self.manager.clone();
        let key = self.key.clone();
        let operation = self.checkpoint.state.id.clone();
        let progress = Arc::new(move |mut event: AgentEvent| {
            event.run_id = format!("preparation:{operation}");
            manager.event(&key, event, "session");
        });
        let context = crate::working_context::prompt_context(
            &self.storage,
            &workspace.review.repository_id,
            &self.checkpoint.state.review_id,
            &workspace.snapshot.id,
            true,
        )?;
        let variables = BTreeMap::from([
            ("language".into(), language),
            ("profile".into(), serde_json::to_string(&draft.profile)?),
            ("working_context".into(), serde_json::to_string(&context)?),
        ]);
        // Persist the chosen profile before launching the harness.
        self.checkpoint
            .results
            .insert("session".into(), serde_json::to_value(&draft)?);
        self.update(|state| {
            state.steps = draft.progress();
            state.phases.clear();
            state.total_batches = state.steps.len() as u32;
        });
        self.persist().await?;
        let run = runtime.run_session(
            &template,
            variables,
            bridge.configuration.clone(),
            progress,
            self.cancel.clone(),
        );
        tokio::pin!(run);
        loop {
            tokio::select! {
                result = &mut run => { result?; break; },
                Some(call) = calls.recv() => {
                    let result = match call.name.as_str() {
                        "review_state" => {
                            let offset = call.arguments["offset"].as_u64().unwrap_or(0) as usize;
                            let limit = call.arguments["limit"].as_u64().unwrap_or(100).clamp(1,200) as usize;
                            let previous: Vec<_> = old_steps(baseline.as_ref()).into_iter().map(|step| json!({"id":step.id,"title":step.title,"anchors":step.anchors,"profile":step.documents.single.as_ref().map(|s|&s.profile),"valid":baseline.as_ref().and_then(|source|retained(source,&workspace.snapshot,step,&draft.profile)).is_some(),"reason":"Retention requires identical captured anchors, dependencies and writing profile."})).collect();
                            let sources = reader::sources(&workspace.snapshot);
                            let previous_sources = baseline.as_ref().map(|w|reader::sources(&w.snapshot)).unwrap_or_default();
                            let total = sources.len().max(workspace.snapshot.changes.len()).max(previous.len()).max(previous_sources.len());
                            Ok(json!({"snapshotId":workspace.snapshot.id,"draft":{"revision":draft.revision,"profile":draft.profile,"planned":draft.planned,"journal":draft.journal,"steps":draft.steps,"decisions":draft.decisions,"finished":draft.finished},"sources":sources.iter().skip(offset).take(limit).collect::<Vec<_>>(),"changes":workspace.snapshot.changes.iter().skip(offset).take(limit).collect::<Vec<_>>(),"previousDocuments":previous.iter().skip(offset).take(limit).collect::<Vec<_>>(),"previousSources":previous_sources.iter().skip(offset).take(limit).collect::<Vec<_>>(),"humanDecisions":baseline.as_ref().map(|w|&w.review.decisions),"offset":offset,"nextOffset":(offset+limit<total).then_some(offset+limit)}))
                        }
                        "review_source" => {
                            let snapshot = if call.arguments["previous"] == true { baseline.as_ref().map(|w|&w.snapshot) } else { Some(&workspace.snapshot) };
                            snapshot.ok_or_else(||invalid("No previous capture.")).and_then(|snapshot|reader::source(&self.storage,snapshot,call.arguments["sourceId"].as_str().unwrap_or_default())).map(|source| {
                                let start = call.arguments["startLine"].as_u64().unwrap_or(1).max(1) as usize;
                                let count = call.arguments["lineCount"].as_u64().unwrap_or(200).clamp(1,1000) as usize;
                                let text = source.text.as_deref().unwrap_or_default();
                                let lines:Vec<_> = text.lines().skip(start-1).take(count).collect();
                                json!({"sourceId":call.arguments["sourceId"],"startLine":start,"totalLines":text.lines().count(),"text":lines.join("\n").chars().take(100_000).collect::<String>()})
                            })
                        }
                        "review_read_document" => {
                            let step = call.arguments["stepId"].as_str().unwrap_or_default();
                            let document = if call.arguments["previous"] == true { old_steps(baseline.as_ref()).into_iter().find(|s|s.id==step).map(|s|&s.documents) } else { draft.documents.get(step) };
                            document.ok_or_else(||invalid("Unknown document.")).map(|documents| {
                                let offset = call.arguments["offset"].as_u64().unwrap_or(0) as usize;
                                let doc = documents.get(ReadingLevel::Essential);
                                json!({"body":doc.body.chars().skip(offset).take(100_000).collect::<String>(),"offset":offset,"totalCharacters":doc.body.chars().count(),"references":doc.references,"glossary":documents.glossary,"terms":doc.terms})
                            })
                        }
                        "review_search" => {
                            let snapshot = if call.arguments["previous"] == true { baseline.as_ref().map(|w|&w.snapshot) } else { Some(&workspace.snapshot) };
                            let query = call.arguments["query"].as_str().unwrap_or_default();
                            if query.is_empty() { Err(invalid("A search query is required.")) } else if let Some(snapshot) = snapshot {
                                let mut hits=Vec::new();
                                for source in reader::sources(snapshot) {
                                    self.check_cancel()?;
                                    if let Some(text)=reader::source(&self.storage,snapshot,&source.source_id)?.text {
                                        for (line,text) in text.lines().enumerate().filter(|(_,text)|text.contains(query)) {
                                            hits.push(json!({"sourceId":source.source_id,"line":line+1,"text":text.chars().take(1000).collect::<String>()}));
                                            if hits.len()>=200 { break; }
                                        }
                                    }
                                    if hits.len()>=200 { break; }
                                }
                                Ok(json!({"limited":hits.len()>=200,"matches":hits}))
                            } else { Err(invalid("No previous capture.")) }
                        }
                        "review_context_assess" => {
                            match serde_json::from_value::<Vec<WorkingContextAssessment>>(call.arguments["assessments"].clone()) {
                                Ok(assessments) => match &mut self.checkpoint.working_context {
                                    Some(context) => crate::working_context::assess(&self.storage,context,&assessments).map(|_|json!({"recorded":true})),
                                    None => Err(invalid("No frozen work context.")),
                                },
                                Err(error) => Err(error.into()),
                            }
                        }
                        "review_activity" => {
                            let text = call.arguments["text"].as_str().unwrap_or_default();
                            if text.len()>8000 { Err(invalid("Activity text is too long.")) } else if call.arguments["stepId"].as_str().is_some_and(|id| !draft.steps.iter().any(|s|s.id==id)) { Err(invalid("Unknown activity step.")) } else {
                                if let Some(id) = call.arguments["stepId"].as_str() {
                                    let status = match call.arguments["state"].as_str() { Some("error") => PreparationStepStatus::Failed, Some("planned") => PreparationStepStatus::Queued, _ => PreparationStepStatus::Writing };
                                    draft.activity.insert(id.into(),status);
                                    self.checkpoint.results.insert("session".into(),serde_json::to_value(&draft)?);
                                    self.update(|state|state.steps=draft.progress());
                                }
                                self.notice(text); self.persist().await.map(|_|json!({"recorded":true}))
                            }
                        }
                        name => {
                            let mut candidate = draft.clone();
                            match candidate.call(name,call.arguments,&self.storage,&workspace,baseline.as_ref()) {
                                Err(error) => Err(error),
                                Ok(value) => {
                                    self.checkpoint.results.insert("session".into(),serde_json::to_value(&candidate)?);
                                    self.update(|state| { state.steps=candidate.progress(); state.total_batches=state.steps.iter().filter(|s|s.status!=PreparationStepStatus::Removed).count() as u32; state.completed_batches=state.steps.iter().filter(|s|s.status==PreparationStepStatus::Ready).count() as u32;
                                        if let Some(update)=&mut state.adaptation {
                                            update.retained_steps=candidate.decisions.values().filter(|d|d.as_str()=="keep").count() as u32;
                                            update.rewritten_steps=candidate.decisions.values().filter(|d|d.as_str()=="modify").count() as u32;
                                            update.added_steps=candidate.decisions.values().filter(|d|d.as_str()=="add").count() as u32;
                                            update.removed_steps=candidate.decisions.values().filter(|d|d.as_str()=="remove").count() as u32;
                                        } });
                                    match self.persist().await {
                                        Ok(()) => { draft=candidate; self.notice(if draft.finished { "Review documents are ready for human review." } else { "Review plan and saved documents updated." }); Ok(value) },
                                        Err(error) => Err(error),
                                    }
                                }
                            }
                        }
                    };
                    let _ = call.reply.send(result);
                }
            }
        }
        if !draft.finished {
            return Err(AppError::new(
                "preparation_incomplete",
                "Rev stopped without confirming completion. Saved documents can be resumed.",
            ));
        }
        self.install_session(workspace, &draft).await
    }
    async fn install_session(&mut self, workspace: Workspace, draft: &Draft) -> AppResult<()> {
        self.check_cancel()?;
        let topics = draft.topics();
        let contents = reader::files(&workspace.snapshot)
            .into_iter()
            .map(|file| ReviewFileContent {
                file_id: file.id,
                documents: None,
            })
            .collect();
        let retained: HashSet<_> = draft
            .steps
            .iter()
            .filter(|s| draft.decisions.get(&s.id).map(String::as_str) == Some("keep"))
            .filter_map(|s| s.previous_step_id.clone())
            .collect();
        let storage = self.storage.clone();
        let state = self.checkpoint.state.clone();
        let cancel = self.cancel.clone();
        tokio::task::spawn_blocking(move || {
            if cancel.load(Ordering::Relaxed) {
                return Err(AppError::new(
                    "cancelled",
                    "Preparation stopped before installation.",
                ));
            }
            reader::publish_preparation(
                &storage,
                &workspace.review.id,
                &workspace.snapshot.id,
                &state.id,
                workspace.review.revision,
                topics,
                contents,
            )?;
            if state.adaptation.is_some() {
                adaptation::finish(&storage, &state, &retained)?;
            }
            Ok::<_, AppError>(())
        })
        .await
        .map_err(|e| AppError::new("task", e.to_string()))??;
        Ok(())
    }
}

#[cfg(all(test, unix))]
mod tests;

#[cfg(all(test, unix))]
mod harness_tests;
