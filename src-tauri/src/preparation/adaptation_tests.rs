use super::tests::native::{fixture, resources};
use super::*;
use std::{
    fs,
    process::Command,
    time::{Duration, Instant},
};

fn git(root: &Path, args: &[&str]) {
    let output = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
fn setup() -> (tempfile::TempDir, Storage, Workspace) {
    let (dir, storage, old) = fixture();
    let root = dir.path().join("repo");
    for i in 0..10 {
        fs::write(
            root.join(format!("feature{i}.ts")),
            format!("export const value{i} = 0;\n"),
        )
        .unwrap();
    }
    git(&root, &["add", "*.ts"]);
    git(
        &root,
        &["-c", "commit.gpgsign=false", "commit", "-qm", "baseline"],
    );
    for i in 0..10 {
        fs::write(
            root.join(format!("feature{i}.ts")),
            format!("export const value{i} = 1;\n"),
        )
        .unwrap();
    }
    let workspace = reviews::refresh(&storage, &old.review.id, old.review.revision).unwrap();
    let path = dir.path().join("claude");
    let script = fs::read_to_string(&path).unwrap().replace("batch=value;results=[]", "batch=value;results=[]\nwith (base/'batch-calls').open('a') as output: output.write('batch\\n')");
    let start = script.find("     result={'steps'").unwrap();
    let end = script[start..].find("\n else:").unwrap() + start;
    let replacement = r#"     manifest=json.loads(pathlib.Path(context['reviewManifest']).read_text())
     changes=[json.loads(pathlib.Path(c['metadata']).read_text()) for c in manifest['changes']]
     previous=value.get('previousReview')
     steps=[];removed=[]
     if previous:
       for step in previous['steps']:
        match=next((c for c in changes if c['change']['path']==step['title']),None)
        if match:steps.append(dict(draftId=step['id'],title=step['title'],writingBrief='Explain the changes to '+step['title'],contextSourceIds=[],anchors=match['anchors'],previousStepId=step['id'],reuse=True))
        else:removed.append(step['id'])
     else:steps=[dict(draftId=c['change']['id'],title=c['change']['path'],writingBrief='Explain the changes to '+c['change']['path'],contextSourceIds=[],anchors=c['anchors']) for c in changes]
     if (base/'empty-tour').exists():removed=[s['id'] for s in previous['steps']];steps=[]
     if (base/'merge-tour').exists() and previous:
      removed=[s['id'] for s in previous['steps']]
      steps=[dict(draftId='merged',title='One coherent journey',writingBrief='Explain these related changes together without repetition.',contextSourceIds=[],anchors=[a for c in changes for a in c['anchors']],previousStepId=None,reuse=False)]
     result={'removedSteps':removed,'steps':steps}"#;
    let script = format!("{}{}{}", &script[..start], replacement, &script[end..]);
    // Feature 0 has an indirect dependency on feature 1, beyond its own anchors.
    let script=script.replace("     if (base/'invalid').exists():",r#"     result['contextSources']=[s['sourceId'] for s in json.loads(pathlib.Path(context['reviewManifest']).read_text())['sources'] if s['path']=='feature1.ts'] if value['step']['title']=='feature0.ts' else []
     if (base/'invalid').exists():"#);
    fs::write(path, script).unwrap();
    (dir, storage, workspace)
}
fn wait(
    manager: &PreparationManager,
    storage: &Storage,
    id: &str,
    predicate: impl Fn(&PreparationState) -> bool,
) -> PreparationState {
    let from = Instant::now();
    loop {
        let state = manager.get(storage, id, None).unwrap().unwrap();
        if predicate(&state) {
            return state;
        }
        assert!(from.elapsed() < Duration::from_secs(40), "{state:?}");
        std::thread::sleep(Duration::from_millis(20));
    }
}
fn prepare(manager: &PreparationManager, storage: &Storage, id: &str) -> PreparationState {
    manager
        .start(
            storage.clone(),
            resources(),
            PreparationRequest {
                review_id: id.into(),
                provider: "claude".into(),
            },
        )
        .unwrap();
    let state = wait(manager, storage, id, |s| {
        s.status != PreparationStatus::Running
    });
    assert_eq!(state.status, PreparationStatus::Ready, "{:?}", state.error);
    state
}
fn calls(dir: &Path, kind: &str) -> usize {
    fs::read_to_string(dir.join("calls"))
        .unwrap_or_default()
        .lines()
        .filter(|s| *s == kind)
        .count()
}
fn validate(storage: &Storage, mut w: Workspace, count: usize) -> Workspace {
    w = reviews::apply(
        storage,
        &w.review.id,
        w.review.revision,
        ReviewAction::SetKeepLocal { keep_local: true },
    )
    .unwrap();
    let ids: Vec<_> = w
        .review
        .topics
        .iter()
        .flat_map(|t| &t.steps)
        .take(count)
        .map(|s| s.id.clone())
        .collect();
    for step_id in ids {
        w = reviews::apply(
            storage,
            &w.review.id,
            w.review.revision,
            ReviewAction::ValidateStep { step_id },
        )
        .unwrap();
    }
    w
}
#[test]
fn incremental_ten_steps_reuses_verified_documents_and_only_carries_unchanged_decisions() {
    let (dir, storage, workspace) = setup();
    let manager = PreparationManager::default();
    prepare(&manager, &storage, &workspace.review.id);
    let old = validate(
        &storage,
        reviews::load(&storage, &workspace.review.id).unwrap(),
        9,
    );
    assert_eq!(calls(dir.path(), "readingStep"), 10);
    let before = calls(dir.path(), "outline");
    assert!(
        manager
            .adapt(
                storage.clone(),
                resources(),
                &old.review.id,
                old.review.revision,
                "claude".into()
            )
            .unwrap()
            .is_none()
    );
    assert_eq!(calls(dir.path(), "outline"), before);
    fs::write(
        dir.path().join("repo/feature1.ts"),
        "export const value1 = 2;\n",
    )
    .unwrap();
    // Measure full regeneration and adaptation of the same target capture, each
    let batches = || {
        fs::read_to_string(dir.path().join("batch-calls"))
            .unwrap()
            .lines()
            .count()
    };
    let before_full = batches();
    let full_start = Instant::now();
    let full = reviews::create(&storage, old.snapshot.request.clone()).unwrap();
    prepare(&manager, &storage, &full.review.id);
    let full_time = full_start.elapsed();
    let full_batches = batches() - before_full;
    assert_eq!(calls(dir.path(), "readingStep"), 20);
    storage.remove("review", &full.review.id).unwrap();
    storage
        .collect_review_garbage(&full.review.repository_id)
        .unwrap();
    let before_update = batches();
    let from = Instant::now();
    manager
        .adapt(
            storage.clone(),
            resources(),
            &old.review.id,
            old.review.revision,
            "claude".into(),
        )
        .unwrap()
        .unwrap();
    let state = wait(&manager, &storage, &old.review.id, |s| {
        s.status != PreparationStatus::Running
    });
    assert_eq!(state.status, PreparationStatus::Ready, "{:?}", state.error);
    let new = reviews::load(&storage, &old.review.id).unwrap();
    let update = state.adaptation.unwrap();
    assert_eq!(update.retained_steps, 8);
    assert_eq!(update.rewritten_steps, 2);
    assert_eq!(calls(dir.path(), "readingStep"), 22);
    assert_eq!(new.review.decisions.len(), 7);
    assert!(
        new.review
            .decisions
            .iter()
            .all(|d| d.carried_from.as_ref().unwrap().review_id == old.review.id)
    );
    assert_eq!(
        new.review
            .topics
            .iter()
            .flat_map(|t| &t.steps)
            .map(|s| &s.id)
            .collect::<Vec<_>>(),
        old.review
            .topics
            .iter()
            .flat_map(|t| &t.steps)
            .map(|s| &s.id)
            .collect::<Vec<_>>()
    );
    for step in new.review.topics.iter().flat_map(|t| &t.steps) {
        reader::validate_documents_with_glossary(
            &storage,
            &new.snapshot,
            &step.documents,
            &new.review.glossary,
        )
        .unwrap();
    }
    assert_eq!(storage.list::<Review>("review").unwrap().len(), 1);
    assert!(
        storage
            .get::<Snapshot>("snapshot", &old.snapshot.id)
            .is_err()
    );
    println!(
        "Synthetic provider benchmark, identical target/cache: full={full_time:?} ({full_batches} calls), update={:?} ({} calls); documents 10 -> 2; repairs=0; reused={}, ",
        from.elapsed(),
        batches() - before_update,
        update.retained_steps,
    );
}
#[test]
fn cancelled_update_preserves_source_and_survives_restart_on_the_same_candidate() {
    let (dir, storage, workspace) = setup();
    let manager = PreparationManager::default();
    prepare(&manager, &storage, &workspace.review.id);
    let old = reviews::load(&storage, &workspace.review.id).unwrap();
    fs::write(
        dir.path().join("repo/feature1.ts"),
        "export const value1 = 2;\n",
    )
    .unwrap();
    fs::write(dir.path().join("pause"), "").unwrap();
    let started = manager
        .adapt(
            storage.clone(),
            resources(),
            &old.review.id,
            old.review.revision,
            "claude".into(),
        )
        .unwrap()
        .unwrap();
    wait(&manager, &storage, &old.review.id, |s| {
        s.completed_batches > 0
    });
    assert_eq!(
        reviews::apply(
            &storage,
            &old.review.id,
            old.review.revision,
            ReviewAction::ValidateStep {
                step_id: old.review.topics[0].steps[0].id.clone()
            }
        )
        .unwrap_err()
        .code,
        "review_busy"
    );
    reviews::apply(
        &storage,
        &old.review.id,
        old.review.revision,
        ReviewAction::SavePosition {
            position: old.review.position.clone(),
        },
    )
    .unwrap();
    assert_eq!(
        manager
            .adapt(
                storage.clone(),
                resources(),
                &old.review.id,
                old.review.revision,
                "claude".into()
            )
            .unwrap()
            .unwrap()
            .id,
        started.id
    );
    manager.cancel(&storage, &old.review.id).unwrap();
    wait(&manager, &storage, &old.review.id, |s| {
        s.status == PreparationStatus::Cancelled
    });
    storage
        .collect_review_garbage(&old.review.repository_id)
        .unwrap();
    assert_eq!(
        reviews::load(&storage, &old.review.id).unwrap().snapshot.id,
        old.snapshot.id
    );
    assert_eq!(storage.list::<Review>("review").unwrap().len(), 1);
    let recovered = PreparationManager::default();
    fs::remove_file(dir.path().join("pause")).unwrap();
    // Later working-tree edits do not replace the candidate on resume.
    fs::write(
        dir.path().join("repo/feature1.ts"),
        "export const value1 = 3;\n",
    )
    .unwrap();
    assert_eq!(
        recovered
            .resume(storage.clone(), resources(), &old.review.id)
            .unwrap()
            .snapshot_id,
        started.snapshot_id
    );
    let done = wait(&recovered, &storage, &old.review.id, |s| {
        s.status != PreparationStatus::Running
    });
    assert_eq!(done.status, PreparationStatus::Ready, "{:?}", done.error);
    assert_eq!(
        reviews::load(&storage, &old.review.id).unwrap().snapshot.id,
        started.snapshot_id
    );
}
#[test]
fn completed_review_forks_and_requires_confirmation_when_all_decisions_are_retained() {
    let (dir, storage, workspace) = setup();
    let manager = PreparationManager::default();
    prepare(&manager, &storage, &workspace.review.id);
    let old = validate(
        &storage,
        reviews::load(&storage, &workspace.review.id).unwrap(),
        10,
    );
    assert!(old.review.publication.is_complete());
    // Outside the tour, no step or dependency is changed.
    fs::write(dir.path().join("repo/readme.md"), "New documentation\n").unwrap();
    manager
        .adapt(
            storage.clone(),
            resources(),
            &old.review.id,
            old.review.revision,
            "claude".into(),
        )
        .unwrap();
    let state = wait(&manager, &storage, &old.review.id, |s| {
        s.status != PreparationStatus::Running
    });
    assert_eq!(state.status, PreparationStatus::Ready, "{:?}", state.error);
    let update = state.adaptation.unwrap();
    let next = reviews::load(&storage, &update.destination_review_id).unwrap();
    assert_ne!(next.review.id, old.review.id);
    assert_eq!(
        next.review.publication.origin_review_id,
        Some(old.review.id.clone())
    );
    assert!(next.review.needs_update_confirmation);
    assert!(next.review.publication.keep_local);
    assert!(!next.review.publication.is_complete());
    assert_eq!(next.review.decisions.len(), 10);
    assert_eq!(
        serde_json::to_value(&reviews::load(&storage, &old.review.id).unwrap().review).unwrap(),
        serde_json::to_value(&old.review).unwrap()
    );
    let completed = reviews::apply(
        &storage,
        &next.review.id,
        next.review.revision,
        ReviewAction::CompleteUpdatedReview,
    )
    .unwrap();
    assert_eq!(
        completed.review.publication.status,
        PublicationStatus::CompletedLocal
    );
    assert!(!completed.review.needs_update_confirmation);
}

#[test]
fn old_documents_without_dependencies_are_reusable_but_their_step_decisions_are_not() {
    let (dir, storage, workspace) = setup();
    let manager = PreparationManager::default();
    prepare(&manager, &storage, &workspace.review.id);
    let mut legacy = reviews::load(&storage, &workspace.review.id).unwrap();
    for step in legacy.review.topics.iter_mut().flat_map(|t| &mut t.steps) {
        step.documents.dependencies = None;
    }
    let revision = legacy.review.revision;
    legacy.review.revision += 1;
    storage
        .replace("review", &legacy.review.id, revision, &legacy.review)
        .unwrap();
    let old = validate(&storage, legacy, 9);
    fs::write(dir.path().join("repo/readme.md"), "More context\n").unwrap();
    manager
        .adapt(
            storage.clone(),
            resources(),
            &old.review.id,
            old.review.revision,
            "claude".into(),
        )
        .unwrap();
    let done = wait(&manager, &storage, &old.review.id, |s| {
        s.status != PreparationStatus::Running
    });
    assert_eq!(done.status, PreparationStatus::Ready, "{:?}", done.error);
    assert_eq!(done.adaptation.unwrap().retained_steps, 10);
    assert!(
        reviews::load(&storage, &old.review.id)
            .unwrap()
            .review
            .decisions
            .is_empty()
    );
    assert_eq!(calls(dir.path(), "readingStep"), 10);
}
#[test]
fn failed_update_keeps_both_captures_and_source_mutation_requires_explicit_discard() {
    let (dir, storage, workspace) = setup();
    let manager = PreparationManager::default();
    prepare(&manager, &storage, &workspace.review.id);
    let old = reviews::load(&storage, &workspace.review.id).unwrap();
    fs::write(
        dir.path().join("repo/feature1.ts"),
        "export const value1 = 2;\n",
    )
    .unwrap();
    fs::write(dir.path().join("invalid"), "").unwrap();
    let started = manager
        .adapt(
            storage.clone(),
            resources(),
            &old.review.id,
            old.review.revision,
            "claude".into(),
        )
        .unwrap()
        .unwrap();
    let failed = wait(&manager, &storage, &old.review.id, |s| {
        s.status == PreparationStatus::Failed
    });
    assert!(failed.can_resume);
    assert_eq!(
        serde_json::to_value(reviews::load(&storage, &old.review.id).unwrap()).unwrap(),
        serde_json::to_value(&old).unwrap()
    );
    storage
        .collect_review_garbage(&old.review.repository_id)
        .unwrap();
    storage
        .get::<Snapshot>("snapshot", &old.snapshot.id)
        .unwrap();
    storage
        .get::<Snapshot>("snapshot", &started.snapshot_id)
        .unwrap();
    let changed = reviews::apply(
        &storage,
        &old.review.id,
        old.review.revision,
        ReviewAction::Rename {
            title: "Changed after failure".into(),
        },
    )
    .unwrap();
    assert_eq!(
        manager
            .resume(storage.clone(), resources(), &old.review.id)
            .unwrap_err()
            .code,
        "preparation_changed"
    );
    assert_eq!(
        manager
            .adapt(
                storage.clone(),
                resources(),
                &old.review.id,
                changed.review.revision,
                "claude".into()
            )
            .unwrap_err()
            .code,
        "update_pending"
    );
    manager.discard_update(&storage, &old.review.id).unwrap();
    assert!(
        storage
            .get::<Snapshot>("snapshot", &started.snapshot_id)
            .is_err()
    );
    assert_eq!(
        reviews::load(&storage, &old.review.id)
            .unwrap()
            .review
            .title,
        changed.review.title
    );
    assert!(
        manager
            .get(&storage, &old.review.id, None)
            .unwrap()
            .is_none()
    );
}
#[test]
fn archived_original_forks_without_rewriting_the_reference_or_published_bundle() {
    let (dir, storage, workspace) = setup();
    let manager = PreparationManager::default();
    prepare(&manager, &storage, &workspace.review.id);
    let completed = validate(
        &storage,
        reviews::load(&storage, &workspace.review.id).unwrap(),
        10,
    );
    let published = reviews::apply(
        &storage,
        &completed.review.id,
        completed.review.revision,
        ReviewAction::SetKeepLocal { keep_local: false },
    )
    .unwrap();
    assert_eq!(
        published.review.publication.status,
        PublicationStatus::Published
    );
    let root = dir.path().join("repo");
    git(&root, &["add", ".reviewbox"]);
    git(
        &root,
        &[
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-qm",
            "publish review",
        ],
    );
    let manual = reviews::create(&storage, published.snapshot.request.clone()).unwrap();
    reviews::apply(
        &storage,
        &manual.review.id,
        manual.review.revision,
        ReviewAction::CompleteManualReview,
    )
    .unwrap();
    let archived = reviews::load(&storage, &published.review.id).unwrap();
    assert_eq!(
        archived.review.publication.status,
        PublicationStatus::Archived
    );
    let reference = root.join(format!(".reviewbox/references/{}.json", archived.review.id));
    let before = fs::read(&reference).unwrap();
    fs::write(root.join("readme.md"), "New documentation\n").unwrap();
    manager
        .adapt(
            storage.clone(),
            resources(),
            &archived.review.id,
            archived.review.revision,
            "claude".into(),
        )
        .unwrap();
    let done = wait(&manager, &storage, &archived.review.id, |s| {
        s.status != PreparationStatus::Running
    });
    assert_eq!(done.status, PreparationStatus::Ready, "{:?}", done.error);
    let next = reviews::load(&storage, &done.adaptation.unwrap().destination_review_id).unwrap();
    assert!(next.review.needs_update_confirmation);
    assert!(!next.review.publication.keep_local);
    assert_eq!(fs::read(&reference).unwrap(), before);
    assert_eq!(
        next.review.publication.origin_review_id,
        Some(archived.review.id)
    );
}
#[test]
fn empty_updated_tour_is_manual_and_does_not_complete_the_scope() {
    let (dir, storage, workspace) = setup();
    let manager = PreparationManager::default();
    prepare(&manager, &storage, &workspace.review.id);
    let old = reviews::load(&storage, &workspace.review.id).unwrap();
    fs::write(dir.path().join("repo/readme.md"), "New doc\n").unwrap();
    fs::write(dir.path().join("empty-tour"), "").unwrap();
    manager
        .adapt(
            storage.clone(),
            resources(),
            &old.review.id,
            old.review.revision,
            "claude".into(),
        )
        .unwrap();
    let done = wait(&manager, &storage, &old.review.id, |s| {
        s.status != PreparationStatus::Running
    });
    assert_eq!(done.status, PreparationStatus::Ready, "{:?}", done.error);
    let review = reviews::load(&storage, &old.review.id).unwrap().review;
    assert_eq!(review.mode, ReviewMode::Manual);
    assert!(!review.publication.is_complete());
    assert!(!review.needs_update_confirmation);
    assert!(review.topics.is_empty());
    assert_eq!(review.position.context, ReadingContext::Files);
}

#[test]
fn rebinding_never_guesses_after_path_layer_mode_range_or_ambiguous_changes() {
    let (_dir, storage, workspace) = setup();
    let manager = PreparationManager::default();
    prepare(&manager, &storage, &workspace.review.id);
    let mut old = reviews::load(&storage, &workspace.review.id).unwrap();
    let initial = &old.review.topics[2].steps[0];
    let old_change = initial.anchors[0].change_id.clone();
    let previous_source = format!("change:{old_change}:after");
    old.review.topics[2].steps[0]
        .documents
        .technical
        .references
        .push(DocumentReference {
            id: "ref".into(),
            label: "Value".into(),
            explanation: "The captured value".into(),
            source_id: previous_source.clone(),
            start_line: 1,
            end_line: 1,
        });
    old.review.topics[2].steps[0]
        .documents
        .technical
        .body
        .push_str(" [Value](reviewbox:ref/ref)");
    let previous = &old.review.topics[2];
    let old_step = &previous.steps[0];
    let mut next = old.snapshot.clone();
    next.id = id();
    for c in &mut next.changes {
        c.id = format!("new-{}", c.id);
        for p in &mut c.passages {
            p.id = format!("new-{}", p.id);
        }
    }
    let step = OutlineStep {
        draft_id: "retained".into(),
        previous_step_id: Some(old_step.id.clone()),
        reuse: true,
        title: old_step.title.clone(),
        analysis: None,
        writing_brief: "Retain the explanation of this behavior and its effects.".into(),
        context_source_ids: vec![],
        anchors: old_step
            .anchors
            .iter()
            .map(|a| CodeAnchor {
                snapshot_id: next.id.clone(),
                change_id: format!("new-{}", a.change_id),
                passage_id: format!("new-{}", a.passage_id),
            })
            .collect(),
    };
    let topic = OutlineTopic {
        title: previous.title.clone(),
        brief: previous.brief.clone(),
        steps: vec![],
    };
    let signature = &old_step.documents.dependencies.as_ref().unwrap().signature;
    let reused = adaptation::reuse_documents(&old, &next, &topic, &step, signature).unwrap();
    let mut with_context = step.clone();
    with_context.context_source_ids = vec![
        reused.dependencies.as_ref().unwrap().sources[0]
            .source_id
            .clone(),
    ];
    assert!(adaptation::reuse_documents(&old, &next, &topic, &with_context, signature).is_some());
    let new_context = reader::sources(&next)
        .into_iter()
        .find(|source| {
            !reused
                .dependencies
                .as_ref()
                .unwrap()
                .sources
                .iter()
                .any(|known| known.source_id == source.source_id)
        })
        .unwrap();
    with_context.context_source_ids = vec![new_context.source_id];
    assert!(adaptation::reuse_documents(&old, &next, &topic, &with_context, signature).is_none());
    let mut with_analysis = step.clone();
    with_analysis.analysis = Some(JourneyAnalysis {
        before: "Before".into(),
        after: "After".into(),
        relationships: "Related".into(),
        consequences: "Effect".into(),
        uncertainties: vec![],
        evidence: vec![AnalysisEvidence {
            fact: "New external evidence".into(),
            source_id: with_context.context_source_ids[0].clone(),
            start_line: 1,
            end_line: 1,
        }],
    });
    assert!(
        adaptation::reuse_documents(&old, &next, &topic, &with_analysis, signature).is_none(),
        "An analysis dossier cannot silently add unverified external dependencies"
    );

    assert_ne!(reused.technical.references[0].source_id, previous_source);
    reader::validate_documents(&storage, &next, &reused).unwrap();
    assert_eq!(
        adaptation::capture_key(&old.snapshot).unwrap(),
        adaptation::capture_key(&next).unwrap()
    );
    let mut reordered = next.clone();
    for change in reordered.changes.iter_mut().take(2) {
        change.after.as_mut().unwrap().mode = "100755".into();
    }
    let comparison = adaptation::comparison(&old.snapshot, &reordered);
    reordered.changes.reverse();
    reordered.files.reverse();
    assert_eq!(
        comparison,
        adaptation::comparison(&old.snapshot, &reordered)
    );
    let mut scope = next.clone();
    scope.git_refs = vec!["new-head".into(), "base".into(), "target".into()];
    assert_eq!(
        adaptation::capture_key(&next).unwrap(),
        adaptation::capture_key(&scope).unwrap()
    );
    scope.request.scope = Scope::Commit;
    let mut another_commit = scope.clone();
    another_commit.git_refs[2] = "another-target-with-identical-tree".into();
    assert_ne!(
        adaptation::capture_key(&scope).unwrap(),
        adaptation::capture_key(&another_commit).unwrap()
    );
    let index = next
        .changes
        .iter()
        .position(|c| c.id == step.anchors[0].change_id)
        .unwrap();
    for mutation in 0..7 {
        let mut modified = next.clone();
        let change = &mut modified.changes[index];
        match mutation {
            0 => change.path = "renamed.ts".into(),
            1 => change.layer = "staged".into(),
            2 => change.after.as_mut().unwrap().mode = "100755".into(),
            3 => change.passages[0].new_start += 1,
            4 => change.previous_path = Some("other.ts".into()),
            5 => {
                let duplicate = change.clone();
                modified.changes.push(duplicate);
            }
            _ => change.after.as_mut().unwrap().hash = "other".into(),
        }
        assert!(
            adaptation::reuse_documents(&old, &modified, &topic, &step, signature).is_none(),
            "mutation {mutation}"
        );
    }
}
#[test]
fn file_decisions_keep_all_layers_independent_of_step_decisions() {
    let (dir, storage, workspace) = setup();
    let manager = PreparationManager::default();
    prepare(&manager, &storage, &workspace.review.id);
    let mut old = reviews::load(&storage, &workspace.review.id).unwrap();
    for path in ["feature3.ts", "feature5.ts"] {
        let file_id = old
            .review
            .files
            .iter()
            .find(|f| f.path == path)
            .unwrap()
            .id
            .clone();
        old = reviews::apply(
            &storage,
            &old.review.id,
            old.review.revision,
            ReviewAction::ValidateFile { file_id },
        )
        .unwrap();
    }
    git(&dir.path().join("repo"), &["add", "feature5.ts"]);
    manager
        .adapt(
            storage.clone(),
            resources(),
            &old.review.id,
            old.review.revision,
            "claude".into(),
        )
        .unwrap();
    let done = wait(&manager, &storage, &old.review.id, |s| {
        s.status != PreparationStatus::Running
    });
    assert_eq!(done.status, PreparationStatus::Ready, "{:?}", done.error);
    let new = reviews::load(&storage, &old.review.id).unwrap();
    assert_eq!(new.review.decisions.len(), 1);
    let decision = &new.review.decisions[0];
    let file = new
        .review
        .files
        .iter()
        .find(|f| f.path == "feature3.ts")
        .unwrap();
    assert_eq!(
        decision.target,
        DecisionTarget::File {
            file_id: file.id.clone()
        }
    );
    let previous = old
        .review
        .decisions
        .iter()
        .find(|d| d.target == decision.target)
        .unwrap();
    assert_eq!(decision.author, previous.author);
    assert_eq!(decision.created_at, previous.created_at);
    assert_eq!(reviews::coverage(&new).validated, 0);
}
#[test]
fn orphan_candidate_recovers_and_committed_result_is_idempotent_after_lost_final_checkpoint() {
    let (dir, storage, workspace) = setup();
    let manager = PreparationManager::default();
    prepare(&manager, &storage, &workspace.review.id);
    let old = reviews::load(&storage, &workspace.review.id).unwrap();
    fs::write(
        dir.path().join("repo/feature1.ts"),
        "export const value1 = 2;\n",
    )
    .unwrap();
    fs::write(dir.path().join("pause"), "").unwrap();
    let state = manager
        .adapt(
            storage.clone(),
            resources(),
            &old.review.id,
            old.review.revision,
            "claude".into(),
        )
        .unwrap()
        .unwrap();
    wait(&manager, &storage, &old.review.id, |s| {
        s.completed_batches > 0
    });
    manager.cancel(&storage, &old.review.id).unwrap();
    wait(&manager, &storage, &old.review.id, |s| {
        s.status == PreparationStatus::Cancelled
    });
    let key = format!("{}:{}", old.review.repository_id, old.review.id);
    storage.remove(KIND, &key).unwrap();
    while !manager.active.lock().unwrap()[&key]
        .finished
        .load(Ordering::Acquire)
    {
        std::thread::sleep(Duration::from_millis(10));
    }
    drop(manager);
    drop(storage);
    let reopened = Storage::open(dir.path().join("local")).unwrap();
    crate::repositories::open(&reopened, dir.path().join("repo").to_str().unwrap()).unwrap();
    let restored = PreparationManager::default();
    let calls_before = calls(dir.path(), "outline");
    // Polling surfaces can all discover the same orphan candidate at once.
    // Recovery must create its checkpoint once, without racing another poll.
    let barrier = std::sync::Barrier::new(16);
    let states = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..16)
            .map(|_| {
                let barrier = &barrier;
                let restored = &restored;
                let reopened = &reopened;
                let review_id = &old.review.id;
                scope.spawn(move || {
                    barrier.wait();
                    restored.get(reopened, review_id, None)
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap().unwrap().unwrap())
            .collect::<Vec<_>>()
    });
    for recovered in &states {
        assert_eq!(recovered.id, state.id);
        assert_eq!(recovered.status, PreparationStatus::Interrupted);
    }
    let paused = &states[0];
    assert_eq!(paused.status, PreparationStatus::Interrupted);
    assert_eq!(paused.id, state.id);
    assert_eq!(paused.snapshot_id, state.snapshot_id);
    assert_eq!(calls(dir.path(), "outline"), calls_before);
    reopened
        .collect_review_garbage(&old.review.repository_id)
        .unwrap();
    fs::remove_file(dir.path().join("pause")).unwrap();
    restored
        .resume(reopened.clone(), resources(), &old.review.id)
        .unwrap();
    let done = wait(&restored, &reopened, &old.review.id, |s| {
        s.status != PreparationStatus::Running
    });
    assert_eq!(done.status, PreparationStatus::Ready, "{:?}", done.error);
    let new = reviews::load(&reopened, &old.review.id).unwrap();
    let calls_before = calls(dir.path(), "outline");
    let mut interrupted = optional_checkpoint(&reopened, &key).unwrap().unwrap();
    interrupted.state.status = PreparationStatus::Running;
    save(&reopened, &mut interrupted).unwrap();
    let recovered = PreparationManager::default();
    assert_eq!(
        recovered
            .get(&reopened, &old.review.id, None)
            .unwrap()
            .unwrap()
            .status,
        PreparationStatus::Ready
    );
    assert_eq!(
        recovered
            .resume(reopened.clone(), resources(), &old.review.id)
            .unwrap()
            .status,
        PreparationStatus::Ready
    );
    assert_eq!(calls(dir.path(), "outline"), calls_before);
    assert_eq!(
        reviews::load(&reopened, &old.review.id)
            .unwrap()
            .review
            .revision,
        new.review.revision
    );
}

#[test]
fn merged_journey_rewrites_documents_without_carrying_human_decisions() {
    let (dir, storage, workspace) = setup();
    let manager = PreparationManager::default();
    prepare(&manager, &storage, &workspace.review.id);
    let old = validate(
        &storage,
        reviews::load(&storage, &workspace.review.id).unwrap(),
        9,
    );
    fs::write(
        dir.path().join("repo/feature1.ts"),
        "export const value1 = 2;\n",
    )
    .unwrap();
    fs::write(dir.path().join("merge-tour"), "").unwrap();
    manager
        .adapt(
            storage.clone(),
            resources(),
            &old.review.id,
            old.review.revision,
            "claude".into(),
        )
        .unwrap();
    let state = wait(&manager, &storage, &old.review.id, |s| {
        s.status != PreparationStatus::Running
    });
    assert_eq!(state.status, PreparationStatus::Ready, "{:?}", state.error);
    let next = reviews::load(&storage, &old.review.id).unwrap();
    assert_eq!(next.review.topics.len(), 1);
    assert_eq!(next.review.topics[0].steps.len(), 1);
    assert!(next.review.decisions.is_empty());
    assert!(
        !old.review
            .topics
            .iter()
            .flat_map(|t| &t.steps)
            .any(|s| s.id == next.review.topics[0].steps[0].id)
    );
    assert_eq!(state.adaptation.unwrap().removed_steps, 10);
    let exported = reader::summary(&next, ReadingLevel::Explained);
    assert_eq!(exported.matches("One coherent journey").count(), 1);
    assert!(!exported.contains("### "));
}
