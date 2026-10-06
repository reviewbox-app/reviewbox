use super::*;
use crate::repositories;
use std::{fs, path::Path, process::Command};
fn git(root: &Path, args: &[&str]) {
    assert!(
        Command::new("git")
            .args(args)
            .current_dir(root)
            .output()
            .unwrap()
            .status
            .success()
    );
}
fn fixture() -> (tempfile::TempDir, Storage, Workspace) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("repo");
    fs::create_dir(&root).unwrap();
    git(&root, &["init", "-q"]);
    git(&root, &["config", "user.email", "test@example.invalid"]);
    git(&root, &["config", "user.name", "Test"]);
    fs::write(root.join("a.ts"), "const a = 1;\n").unwrap();
    git(&root, &["add", "."]);
    git(&root, &["commit", "-qm", "initial"]);
    fs::write(root.join("a.ts"), "const a = 2;\n").unwrap();
    git(&root, &["add", "a.ts"]);
    fs::write(root.join("a.ts"), "const a = 3;\n").unwrap();
    fs::write(root.join("outside.ts"), "export const outside = true\n").unwrap();
    let storage = Storage::open(dir.path().join("data")).unwrap();
    let repo = repositories::open(&storage, root.to_str().unwrap()).unwrap();
    let w = create(
        &storage,
        CaptureRequest {
            repository_id: repo.id,
            scope: Scope::Local,
            base: None,
            target: None,
            include_untracked: true,
        },
    )
    .unwrap();
    (dir, storage, w)
}
fn docs() -> LevelDocuments {
    let d = ReviewDocument {
        term_aliases: Default::default(),
        body: "A simple explanation.".into(),
        references: vec![],
        terms: vec![],
        reading_seconds: 15,
    };
    LevelDocuments {
        dependencies: None,
        context_sources: vec![],
        glossary: vec![],
        essential: d.clone(),
        explained: d.clone(),
        technical: d,
    }
}
fn guided(s: &Storage, mut w: Workspace) -> Workspace {
    let c = &w.snapshot.changes[0];
    let anchor = CodeAnchor {
        snapshot_id: w.snapshot.id.clone(),
        change_id: c.id.clone(),
        passage_id: c.passages[0].id.clone(),
    };
    w.review.mode = ReviewMode::Guided;
    w.review.topics = vec![Topic {
        id: "topic".into(),
        title: "Title".into(),
        brief: "".into(),
        steps: (0..2)
            .map(|i| Step {
                id: format!("step{i}"),
                title: format!("Step{i}"),
                documents: docs(),
                anchors: vec![anchor.clone()],
            })
            .collect(),
    }];
    s.replace("review", &w.review.id, w.review.revision, &w.review)
        .unwrap();
    load(s, &w.review.id).unwrap()
}
#[test]
fn step_and_file_decisions_are_independent_and_guided_completion_ignores_outside() {
    let (_d, s, w) = fixture();
    let mut w = guided(&s, w);
    assert_eq!(w.review.files.len(), 2);
    assert_eq!(coverage(&w).total, 2);
    w = apply(
        &s,
        &w.review.id,
        w.review.revision,
        ReviewAction::ValidateStep {
            step_id: "step0".into(),
        },
    )
    .unwrap();
    assert_eq!(coverage(&w).validated, 1);
    assert_eq!(w.review.decisions.len(), 1);
    w = apply(
        &s,
        &w.review.id,
        w.review.revision,
        ReviewAction::ValidateFile {
            file_id: crate::reader::file_id("a.ts"),
        },
    )
    .unwrap();
    assert_eq!(coverage(&w).validated, 1);
    w = apply(
        &s,
        &w.review.id,
        w.review.revision,
        ReviewAction::ValidateStep {
            step_id: "step1".into(),
        },
    )
    .unwrap();
    assert!(coverage(&w).complete);
    assert_eq!(w.review.decisions.len(), 3);
}
#[test]
fn a_step_with_one_invalid_anchor_never_partially_validates() {
    let (_d, s, w) = fixture();
    let mut w = guided(&s, w);
    w.review.topics[0].steps[0].anchors.push(CodeAnchor {
        snapshot_id: w.snapshot.id.clone(),
        change_id: "invalid".into(),
        passage_id: "invalid".into(),
    });
    s.replace("review", &w.review.id, w.review.revision, &w.review)
        .unwrap();
    let w = load(&s, &w.review.id).unwrap();
    assert!(
        apply(
            &s,
            &w.review.id,
            w.review.revision,
            ReviewAction::ValidateStep {
                step_id: "step0".into()
            }
        )
        .is_err()
    );
    assert!(load(&s, &w.review.id).unwrap().review.decisions.is_empty());
}
#[test]
fn file_validation_without_generated_assets_covers_both_layers() {
    let (_d, s, w) = fixture();
    let file = w.review.files.iter().find(|f| f.path == "a.ts").unwrap();
    assert_eq!(file.change_ids.len(), 2);
    let next = apply(
        &s,
        &w.review.id,
        w.review.revision,
        ReviewAction::ValidateFile {
            file_id: file.id.clone(),
        },
    )
    .unwrap();
    assert_eq!(next.review.decisions.len(), 1);
    assert_eq!(coverage(&next).validated, 1);
    assert!(!coverage(&next).complete);
}
#[test]
fn stale_revision_never_overwrites_a_decision() {
    let (_d, s, w) = fixture();
    let file = &w.review.files[0];
    let next = apply(
        &s,
        &w.review.id,
        0,
        ReviewAction::ValidateFile {
            file_id: file.id.clone(),
        },
    )
    .unwrap();
    assert!(
        apply(
            &s,
            &w.review.id,
            0,
            ReviewAction::ReopenFile {
                file_id: file.id.clone()
            }
        )
        .is_err()
    );
    assert_eq!(
        load(&s, &w.review.id).unwrap().review.decisions.len(),
        next.review.decisions.len()
    );
}
#[test]
fn generated_assets_are_lazy_integrity_checked_and_survive_review_updates() {
    let (dir, s, w) = fixture();
    let w = guided(&s, w);
    let contents = w
        .review
        .files
        .iter()
        .map(|f| ReviewFileContent {
            file_id: f.id.clone(),
            documents: Some(docs()),
        })
        .collect();
    let w = crate::reader::publish_preparation(
        &s,
        &w.review.id,
        &w.snapshot.id,
        "prepared",
        w.review.revision,
        w.review.topics.clone(),
        contents,
    )
    .unwrap();
    let file = &w.review.files[0];
    assert!(
        crate::reader::read_file(&s, &w.review.id, &file.id)
            .unwrap()
            .documents
            .is_some()
    );
    let w = apply(
        &s,
        &w.review.id,
        w.review.revision,
        ReviewAction::Rename {
            title: "renamed".into(),
        },
    )
    .unwrap();
    assert!(crate::reader::read_file(&s, &w.review.id, &file.id).is_ok());
    let path = dir.path().join(format!(
        "repo/.reviewbox/.local/reviews/{}/generated/{}/prepared/0001.json",
        w.review.id, w.review.id
    ));
    fs::write(path, "corrupt").unwrap();
    assert!(load(&s, &w.review.id).is_ok());
    assert_eq!(
        crate::reader::read_file(&s, &w.review.id, &file.id)
            .unwrap_err()
            .code,
        "corrupt_asset"
    );
}
#[test]
fn sources_are_exact_and_reject_invented_ids() {
    let (dir, s, w) = fixture();
    let source = crate::reader::sources(&w.snapshot)
        .into_iter()
        .find(|v| v.source_id.ends_with(":after"))
        .unwrap();
    let before = crate::reader::source(&s, &w.snapshot, &source.source_id)
        .unwrap()
        .text
        .unwrap();
    fs::write(dir.path().join("repo/a.ts"), "different today").unwrap();
    assert_eq!(
        crate::reader::source(&s, &w.snapshot, &source.source_id)
            .unwrap()
            .text
            .unwrap(),
        before
    );
    assert!(crate::reader::source(&s, &w.snapshot, "file:../../secret").is_err());
}

#[test]
fn examination_does_not_validate_or_complete_a_step() {
    let (_d, s, w) = fixture();
    let w = guided(&s, w);
    let w = apply(
        &s,
        &w.review.id,
        w.review.revision,
        ReviewAction::ExamineStep {
            step_id: "step0".into(),
        },
    )
    .unwrap();
    assert_eq!(w.review.decisions[0].state, DecisionState::Examined);
    assert_eq!(coverage(&w).validated, 0);
    let w = apply(
        &s,
        &w.review.id,
        w.review.revision,
        ReviewAction::ValidateStep {
            step_id: "step0".into(),
        },
    )
    .unwrap();
    assert_eq!(w.review.decisions.len(), 1);
    assert_eq!(w.review.decisions[0].state, DecisionState::Validated);
}
#[test]
fn essential_identifiers_are_allowed_and_invalid_reference_ids_are_rejected() {
    let (_d, s, w) = fixture();
    let mut documents = docs();
    documents.essential.body = "Look at `const`".into();
    crate::reader::validate_documents(&s, &w.snapshot, &documents).unwrap();
    let mut documents = docs();
    documents.technical.references.push(DocumentReference {
        id: "bad/id".into(),
        label: "Read".into(),
        explanation: "Details".into(),
        source_id: crate::reader::sources(&w.snapshot)[0].source_id.clone(),
        start_line: 1,
        end_line: 1,
    });
    assert!(crate::reader::validate_documents(&s, &w.snapshot, &documents).is_err());
}

#[test]
fn source_fences_validate_references_with_both_markdown_delimiters() {
    let (_d, s, w) = fixture();
    for marker in ["```", "~~~", "````"] {
        let mut documents = docs();
        documents.technical.body = format!("{marker}source\nmissing\n{marker}");
        assert!(crate::reader::validate_documents(&s, &w.snapshot, &documents).is_err());
        documents.technical.references.push(DocumentReference {
            id: "missing".into(),
            label: "Source".into(),
            explanation: "Captured line".into(),
            source_id: crate::reader::sources(&w.snapshot)[0].source_id.clone(),
            start_line: 1,
            end_line: 1,
        });
        crate::reader::validate_documents(&s, &w.snapshot, &documents).unwrap();
        documents.essential.body = format!("{marker}rust\nlet source = true;\n{marker}");
        assert!(crate::reader::validate_documents(&s, &w.snapshot, &documents).is_err());
    }
}

#[test]
fn a_staged_edit_then_unstaged_rename_remains_one_logical_file() {
    let (dir, s, w) = fixture();
    let root = dir.path().join("repo");
    fs::remove_file(root.join("outside.ts")).unwrap();
    fs::write(root.join("a.ts"), "const a = 2;\n").unwrap();
    fs::rename(root.join("a.ts"), root.join("renamed.ts")).unwrap();
    let next = create(&s, w.snapshot.request).unwrap();
    assert_eq!(next.review.files.len(), 1);
    let file = &next.review.files[0];
    assert_eq!(file.path, "renamed.ts");
    assert_eq!(file.change_ids.len(), 3);
    let next = apply(
        &s,
        &next.review.id,
        next.review.revision,
        ReviewAction::ValidateFile {
            file_id: file.id.clone(),
        },
    )
    .unwrap();
    assert!(coverage(&next).complete);
}
#[test]
fn an_unprepared_file_has_explicit_empty_generated_content() {
    let (_d, s, w) = fixture();
    let content = crate::reader::read_file(&s, &w.review.id, &w.review.files[0].id).unwrap();
    assert!(content.documents.is_none());
}

#[test]
fn source_view_can_acknowledge_frozen_binary_bytes_without_a_text_preview() {
    let (directory, storage, workspace) = fixture();
    fs::write(directory.path().join("repo/image.bin"), [0, 255, 17]).unwrap();
    let workspace = create(&storage, workspace.snapshot.request).unwrap();
    let file = workspace
        .review
        .files
        .iter()
        .find(|f| f.path == "image.bin")
        .unwrap();
    let next = apply(
        &storage,
        &workspace.review.id,
        workspace.review.revision,
        ReviewAction::ValidateFile {
            file_id: file.id.clone(),
        },
    )
    .unwrap();
    assert_eq!(next.review.decisions.len(), 1);
}

#[test]
fn refreshing_a_guided_draft_replaces_documents_without_creating_history() {
    let (_d, s, w) = fixture();
    let w = guided(&s, w);
    let w = apply(
        &s,
        &w.review.id,
        w.review.revision,
        ReviewAction::ValidateStep {
            step_id: "step0".into(),
        },
    )
    .unwrap();
    let w = apply(
        &s,
        &w.review.id,
        w.review.revision,
        ReviewAction::ValidateFile {
            file_id: crate::reader::file_id("a.ts"),
        },
    )
    .unwrap();
    let next = refresh(&s, &w.review.id, w.review.revision).unwrap();
    assert_ne!(next.snapshot.id, w.snapshot.id);
    assert_eq!(next.review.mode, ReviewMode::Manual);
    assert!(next.review.topics.is_empty());
    assert!(next.review.preparation_id.is_none());
    assert_eq!(next.review.position.context, ReadingContext::Files);
    assert_eq!(
        next.review.position.file_id.as_ref(),
        Some(&next.review.files[0].id)
    );
    assert!(next.review.position.step_id.is_none());
    assert!(next.review.decisions.is_empty());
    assert!(next.review.previous_snapshot_ids.is_empty());
    let content = crate::reader::read_file(&s, &next.review.id, &next.review.files[0].id).unwrap();
    assert!(content.documents.is_none());
    assert!(
        s.get::<Review>(
            "review_history",
            &format!("{}@{}", w.review.id, w.review.revision)
        )
        .is_err()
    );
    assert!(s.get::<Snapshot>("snapshot", &w.snapshot.id).is_err());
}

#[test]
fn large_step_documents_are_packed_lazily_and_collected_after_draft_refresh() {
    let (directory, storage, workspace) = fixture();
    let change = &workspace.snapshot.changes[0];
    let anchor = CodeAnchor {
        snapshot_id: workspace.snapshot.id.clone(),
        change_id: change.id.clone(),
        passage_id: change.passages[0].id.clone(),
    };
    let mut documents = docs();
    documents.essential.body = "The explanation. ".repeat(7500);
    documents.explained.body = "Detailed logic. ".repeat(7500);
    documents.technical.body = "Source behavior. ".repeat(7500);
    let topics = vec![Topic {
        id: "large".into(),
        title: "Large topic".into(),
        brief: "Many related steps".into(),
        steps: (0..48)
            .map(|index| Step {
                id: format!("large-step-{index}"),
                title: format!("Step {index}"),
                documents: documents.clone(),
                anchors: vec![anchor.clone()],
            })
            .collect(),
    }];
    assert!(serde_json::to_vec(&topics).unwrap().len() > 16 * 1024 * 1024);
    let saved = apply(
        &storage,
        &workspace.review.id,
        workspace.review.revision,
        ReviewAction::SaveTopics { topics },
    )
    .unwrap();
    let root = directory.path().join(format!(
        "repo/.reviewbox/.local/reviews/{}",
        workspace.review.id
    ));
    let topic_path = root.join(format!("reviews/{}/topics/large.json", workspace.review.id));
    let metadata: serde_json::Value =
        serde_json::from_slice(&fs::read(&topic_path).unwrap()).unwrap();
    assert!(fs::metadata(&topic_path).unwrap().len() < 64 * 1024);
    assert!(metadata["data"]["steps"][0].get("documents").is_none());
    let generated = root.join(format!("generated/{}/steps", workspace.review.id));
    let parts: Vec<_> = fs::read_dir(&generated)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert!(parts.len() >= 3);
    assert!(
        parts
            .iter()
            .all(|part| fs::metadata(part).unwrap().len() <= 8 * 1024 * 1024)
    );
    let loaded = load(&storage, &saved.review.id).unwrap();
    assert_eq!(
        serde_json::to_value(&saved.review.topics).unwrap(),
        serde_json::to_value(&loaded.review.topics).unwrap()
    );
    drop(storage);
    let storage = Storage::open(directory.path().join("fresh-cache")).unwrap();
    repositories::open(&storage, directory.path().join("repo").to_str().unwrap()).unwrap();
    assert_eq!(
        load(&storage, &saved.review.id).unwrap().review.topics[0]
            .steps
            .len(),
        48
    );
    let original = fs::read(&parts[0]).unwrap();
    fs::write(&parts[0], "corrupt").unwrap();
    // Unrelated metadata scanning stays lazy; requesting damaged content fails.
    let _: Snapshot = storage.get("snapshot", &saved.snapshot.id).unwrap();
    assert_eq!(
        load(&storage, &saved.review.id).unwrap_err().code,
        "corrupt_asset"
    );
    fs::write(&parts[0], original).unwrap();
    let refreshed = refresh(&storage, &saved.review.id, saved.review.revision).unwrap();
    assert!(refreshed.review.topics.is_empty());
    assert!(refreshed.review.previous_snapshot_ids.is_empty());
    assert!(parts.iter().all(|part| !part.exists()));
    assert!(
        storage
            .get::<Snapshot>("snapshot", &saved.snapshot.id)
            .is_err()
    );
}

#[test]
fn manual_completion_attests_scope_without_fabricating_file_decisions() {
    let (dir, storage, workspace) = fixture();
    let original_id = workspace.review.id.clone();
    let completed = apply(
        &storage,
        &original_id,
        workspace.review.revision,
        ReviewAction::CompleteManualReview,
    )
    .unwrap();
    assert_eq!(
        completed.review.publication.status,
        PublicationStatus::Published
    );
    assert!(completed.review.decisions.is_empty());
    assert_eq!(coverage(&completed).validated, 0);
    let attestation = completed.review.publication.completion.as_ref().unwrap();
    assert_eq!(attestation.kind, ReviewCompletionKind::Manual);
    assert_eq!(
        attestation.scope_fingerprint,
        scope_fingerprint(&workspace.snapshot).unwrap()
    );
    assert_eq!(completed.review.publication.file_count, Some(2));
    assert!(
        dir.path()
            .join(format!("repo/.reviewbox/published/{original_id}"))
            .is_dir()
    );
    let duplicate = apply(
        &storage,
        &original_id,
        workspace.review.revision,
        ReviewAction::CompleteManualReview,
    )
    .unwrap();
    assert_eq!(duplicate.review.revision, completed.review.revision);
    assert_eq!(
        duplicate.review.publication.completion,
        completed.review.publication.completion
    );
}

#[test]
fn completing_locally_then_disabling_keep_local_publishes_once() {
    let (dir, storage, workspace) = fixture();
    let local = apply(
        &storage,
        &workspace.review.id,
        workspace.review.revision,
        ReviewAction::SetKeepLocal { keep_local: true },
    )
    .unwrap();
    let completed = apply(
        &storage,
        &local.review.id,
        local.review.revision,
        ReviewAction::CompleteManualReview,
    )
    .unwrap();
    assert_eq!(
        completed.review.publication.status,
        PublicationStatus::CompletedLocal
    );
    assert!(
        !dir.path()
            .join(format!("repo/.reviewbox/published/{}", completed.review.id))
            .exists()
    );
    let published = apply(
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
    assert_eq!(
        published.review.publication.completion,
        completed.review.publication.completion
    );
    assert!(
        apply(
            &storage,
            &published.review.id,
            published.review.revision,
            ReviewAction::SetKeepLocal { keep_local: true }
        )
        .is_err()
    );
    let retried = apply(
        &storage,
        &published.review.id,
        published.review.revision,
        ReviewAction::RetryPublication,
    )
    .unwrap();
    assert_eq!(published.review.revision, retried.review.revision);
}

#[test]
fn final_guided_step_publishes_and_duplicate_click_preserves_revision() {
    let (_dir, storage, workspace) = fixture();
    let mut workspace = guided(&storage, workspace);
    for step_id in ["step0", "step1"] {
        workspace = apply(
            &storage,
            &workspace.review.id,
            workspace.review.revision,
            ReviewAction::ValidateStep {
                step_id: step_id.into(),
            },
        )
        .unwrap();
    }
    assert_eq!(
        workspace.review.publication.status,
        PublicationStatus::Published
    );
    assert_eq!(
        workspace
            .review
            .publication
            .completion
            .as_ref()
            .unwrap()
            .kind,
        ReviewCompletionKind::Guided
    );
    assert_eq!(workspace.review.publication.step_count, Some(2));
    assert_eq!(workspace.review.decisions.len(), 2);
    let duplicate = apply(
        &storage,
        &workspace.review.id,
        workspace.review.revision - 1,
        ReviewAction::ValidateStep {
            step_id: "step1".into(),
        },
    )
    .unwrap();
    assert_eq!(duplicate.review.revision, workspace.review.revision);
    assert_eq!(duplicate.review.id, workspace.review.id);
}

#[test]
fn completed_review_is_immutable_and_reopening_preserves_original() {
    let (_dir, storage, workspace) = fixture();
    let completed = apply(
        &storage,
        &workspace.review.id,
        workspace.review.revision,
        ReviewAction::CompleteManualReview,
    )
    .unwrap();
    for action in [
        ReviewAction::Rename {
            title: "changed".into(),
        },
        ReviewAction::SaveTopics { topics: vec![] },
        ReviewAction::ExamineFile {
            file_id: completed.review.files[0].id.clone(),
        },
    ] {
        assert_eq!(
            apply(
                &storage,
                &completed.review.id,
                completed.review.revision,
                action
            )
            .unwrap_err()
            .code,
            "immutable_review"
        );
    }
    assert!(
        crate::reader::publish_preparation(
            &storage,
            &completed.review.id,
            &completed.snapshot.id,
            "late-provider",
            completed.review.revision,
            vec![],
            vec![]
        )
        .is_err()
    );
    let reopened = apply(
        &storage,
        &completed.review.id,
        completed.review.revision,
        ReviewAction::ReopenReview,
    )
    .unwrap();
    assert_ne!(reopened.review.id, completed.review.id);
    assert_eq!(reopened.snapshot.id, completed.snapshot.id);
    assert_eq!(
        reopened.review.publication.origin_review_id.as_ref(),
        Some(&completed.review.id)
    );
    assert_eq!(reopened.review.publication.status, PublicationStatus::Draft);
    assert!(reopened.review.publication.completion.is_none());
    assert_eq!(
        load(&storage, &completed.review.id)
            .unwrap()
            .review
            .publication,
        completed.review.publication
    );
}

#[test]
fn completed_refresh_forks_and_draft_refresh_releases_old_snapshot_and_checkpoint() {
    let (dir, storage, workspace) = fixture();
    let local = apply(
        &storage,
        &workspace.review.id,
        workspace.review.revision,
        ReviewAction::SetKeepLocal { keep_local: true },
    )
    .unwrap();
    let completed = apply(
        &storage,
        &local.review.id,
        local.review.revision,
        ReviewAction::CompleteManualReview,
    )
    .unwrap();
    fs::write(dir.path().join("repo/a.ts"), "const a = 4;\n").unwrap();
    let next = refresh(&storage, &completed.review.id, completed.review.revision).unwrap();
    assert_ne!(next.review.id, completed.review.id);
    assert_ne!(next.snapshot.id, completed.snapshot.id);
    assert!(next.review.publication.keep_local);
    assert_eq!(
        load(&storage, &completed.review.id).unwrap().snapshot.id,
        completed.snapshot.id
    );
    let checkpoint_id = format!("{}:{}", next.review.repository_id, next.review.id);
    storage
        .insert(
            "review_preparation",
            &checkpoint_id,
            &serde_json::json!({"revision":0}),
        )
        .unwrap();
    let refreshed = refresh(&storage, &next.review.id, next.review.revision).unwrap();
    assert_eq!(next.review.id, refreshed.review.id);
    assert!(refreshed.review.previous_snapshot_ids.is_empty());
    assert!(
        storage
            .get::<Snapshot>("snapshot", &next.snapshot.id)
            .is_err()
    );
    assert!(
        storage
            .get::<serde_json::Value>("review_preparation", &checkpoint_id)
            .is_err()
    );
    assert!(
        storage
            .get::<Snapshot>("snapshot", &completed.snapshot.id)
            .is_ok()
    );
}

#[test]
fn failed_refresh_preserves_the_draft_and_captured_sources() {
    let (dir, storage, workspace) = fixture();
    let old_sources: Vec<_> = crate::reader::sources(&workspace.snapshot)
        .into_iter()
        .map(|source| {
            (
                source.hash.clone(),
                storage.read_blob(&source.hash).unwrap(),
            )
        })
        .collect();
    let git_dir = dir.path().join("repo/.git");
    fs::rename(&git_dir, dir.path().join("git-temporarily-unavailable")).unwrap();
    assert!(refresh(&storage, &workspace.review.id, workspace.review.revision).is_err());
    fs::rename(dir.path().join("git-temporarily-unavailable"), git_dir).unwrap();
    let preserved = load(&storage, &workspace.review.id).unwrap();
    assert_eq!(preserved.review.snapshot_id, workspace.review.snapshot_id);
    assert_eq!(preserved.review.revision, workspace.review.revision);
    for (hash, bytes) in old_sources {
        assert_eq!(storage.read_blob(&hash).unwrap(), bytes);
    }
}

#[test]
fn private_reading_position_does_not_mutate_published_attestation() {
    let (dir, storage, workspace) = fixture();
    let completed = apply(
        &storage,
        &workspace.review.id,
        workspace.review.revision,
        ReviewAction::CompleteManualReview,
    )
    .unwrap();
    let bundle = dir.path().join(format!(
        "repo/.reviewbox/published/{}/reviews/{}/review.json",
        completed.review.id, completed.review.id
    ));
    let before = fs::read(&bundle).unwrap();
    let position = ReadingPosition {
        line: 9,
        scroll_top: 77.0,
        ..completed.review.position.clone()
    };
    let moved = apply(
        &storage,
        &completed.review.id,
        0,
        ReviewAction::SavePosition { position },
    )
    .unwrap();
    assert_eq!(moved.review.position.line, 9);
    assert_eq!(moved.review.revision, completed.review.revision);
    assert_eq!(fs::read(bundle).unwrap(), before);
}

#[test]
fn refresh_retains_capture_while_a_reader_holds_it_and_collects_after_release() {
    let (_dir, storage, workspace) = fixture();
    let reader = storage.pin_snapshot(&workspace.snapshot.id);
    let refreshed = refresh(&storage, &workspace.review.id, workspace.review.revision).unwrap();
    assert_ne!(workspace.snapshot.id, refreshed.snapshot.id);
    assert!(
        storage
            .get::<Snapshot>("snapshot", &workspace.snapshot.id)
            .is_ok()
    );
    drop(reader);
    assert!(
        storage
            .get::<Snapshot>("snapshot", &workspace.snapshot.id)
            .is_err()
    );
    assert!(
        storage
            .get::<Snapshot>("snapshot", &refreshed.snapshot.id)
            .is_ok()
    );
}

#[test]
fn pending_publication_retries_without_repeating_human_validation() {
    let (_dir, storage, workspace) = fixture();
    let pending = prepare_action(
        &storage,
        workspace.clone(),
        workspace.review.revision,
        ReviewAction::CompleteManualReview,
    )
    .unwrap();
    assert_eq!(
        pending.review.publication.status,
        PublicationStatus::PublicationPending
    );
    storage
        .replace(
            "review",
            &pending.review.id,
            workspace.review.revision,
            &pending.review,
        )
        .unwrap();
    // Simulate an interrupted publication after its durable validation write.
    let retried = apply(
        &storage,
        &pending.review.id,
        pending.review.revision,
        ReviewAction::RetryPublication,
    )
    .unwrap();
    assert_eq!(
        retried.review.publication.status,
        PublicationStatus::Published
    );
    assert_eq!(
        retried.review.publication.completion,
        pending.review.publication.completion
    );
    assert!(retried.review.decisions.is_empty());
}

#[test]
fn garbage_collection_keeps_only_compatible_draft_preparation_checkpoints() {
    let (_dir, storage, workspace) = fixture();
    let repository = workspace.review.repository_id.clone();
    let matching = format!("{repository}:{}", workspace.review.id);
    let stale = format!("{repository}:removed-review");
    let elsewhere = "other-checkout:another-review";
    for (key, repo, review, snapshot) in [
        (
            matching.as_str(),
            repository.as_str(),
            workspace.review.id.as_str(),
            workspace.snapshot.id.as_str(),
        ),
        (
            stale.as_str(),
            repository.as_str(),
            "removed-review",
            "old-snapshot",
        ),
        (
            elsewhere,
            "other-checkout",
            "another-review",
            "other-snapshot",
        ),
    ] {
        storage.insert("review_preparation", key, &serde_json::json!({"revision":0,"repositoryId":repo,"state":{"reviewId":review,"snapshotId":snapshot,"status":"running"}})).unwrap();
    }
    storage.collect_review_garbage(&repository).unwrap();
    assert!(
        storage
            .get::<serde_json::Value>("review_preparation", &matching)
            .is_ok()
    );
    assert!(
        storage
            .get::<serde_json::Value>("review_preparation", &stale)
            .is_err()
    );
    assert!(
        storage
            .get::<serde_json::Value>("review_preparation", elsewhere)
            .is_ok()
    );
    let local = apply(
        &storage,
        &workspace.review.id,
        workspace.review.revision,
        ReviewAction::SetKeepLocal { keep_local: true },
    )
    .unwrap();
    apply(
        &storage,
        &local.review.id,
        local.review.revision,
        ReviewAction::CompleteManualReview,
    )
    .unwrap();
    storage.collect_review_garbage(&repository).unwrap();
    assert!(
        storage
            .get::<serde_json::Value>("review_preparation", &matching)
            .is_err()
    );
    assert!(
        storage
            .get::<serde_json::Value>("review_preparation", elsewhere)
            .is_ok()
    );
}
#[test]
fn reading_modes_write_new_keys_and_preserve_existing_documents() {
    use serde_json::{from_value, json, to_value};
    for (old, new, level) in [
        ("beginner", "essential", ReadingLevel::Essential),
        ("intermediate", "explained", ReadingLevel::Explained),
        ("developer", "technical", ReadingLevel::Technical),
    ] {
        assert_eq!(from_value::<ReadingLevel>(json!(old)).unwrap(), level);
        assert_eq!(from_value::<ReadingLevel>(json!(new)).unwrap(), level);
        assert_eq!(to_value(level).unwrap(), json!(new));
    }
    let document =
        json!({"body":"Saved explanation", "references":[], "terms":[], "readingSeconds":30});
    let saved = json!({"beginner":document, "intermediate":document, "developer":document});
    let documents: LevelDocuments = from_value(saved).unwrap();
    let serialized = to_value(&documents).unwrap();
    for (old, new) in [
        ("beginner", "essential"),
        ("intermediate", "explained"),
        ("developer", "technical"),
    ] {
        assert!(serialized.get(old).is_none());
        assert_eq!(serialized[new]["body"], "Saved explanation");
    }
    assert_eq!(ReadingLevel::default(), ReadingLevel::Explained);
}

#[test]
fn review_freshness_tracks_layers_context_sources_and_reverted_changes() {
    let (dir, storage, w) = fixture();
    let mut workspace = guided(&storage, w);
    let root = dir.path().join("repo");
    let unstaged = workspace
        .snapshot
        .changes
        .iter()
        .find(|c| c.path == "a.ts" && c.layer == "unstaged")
        .unwrap();
    workspace.review.topics[0].steps[1].anchors = vec![CodeAnchor {
        snapshot_id: workspace.snapshot.id.clone(),
        change_id: unstaged.id.clone(),
        passage_id: unstaged.passages[0].id.clone(),
    }];
    assert!(
        !snapshots::review_freshness(&storage, &workspace)
            .unwrap()
            .changed
    );
    fs::write(root.join("a.ts"), "const a = 4;\n").unwrap();
    let status = snapshots::review_freshness(&storage, &workspace).unwrap();
    assert!(status.changed);
    assert_eq!(status.stale_step_ids, vec!["step1"]);
    fs::write(root.join("a.ts"), "const a = 3;\n").unwrap();
    assert!(
        !snapshots::review_freshness(&storage, &workspace)
            .unwrap()
            .changed
    );
    workspace.review.topics[0].steps[0]
        .documents
        .context_sources
        .push("file:outside.ts".into());
    fs::write(root.join("outside.ts"), "export const outside = false\n").unwrap();
    assert_eq!(
        snapshots::review_freshness(&storage, &workspace)
            .unwrap()
            .stale_step_ids,
        vec!["step0"]
    );
    git(&root, &["add", "a.ts"]);
    assert_eq!(
        snapshots::review_freshness(&storage, &workspace)
            .unwrap()
            .stale_step_ids,
        vec!["step0", "step1"]
    );
}

#[test]
fn document_selection_verifies_mode_snapshot_and_current_body() {
    let (_dir, storage, workspace) = fixture();
    let mut workspace = guided(&storage, workspace);
    let mut selection = DocumentSelection {
        snapshot_id: workspace.snapshot.id.clone(),
        step_id: "step0".into(),
        level: ReadingLevel::Explained,
        content_hash: fingerprint(b"A simple explanation."),
        ranges: vec![DocumentTextRange { start: 2, end: 8 }],
    };
    assert_eq!(
        crate::review_documents::verify(&workspace, &selection).unwrap(),
        "simple"
    );
    workspace.review.topics[0].steps[0].documents.explained.body = "An updated explanation.".into();
    assert!(crate::review_documents::verify(&workspace, &selection).is_err());
    selection.level = ReadingLevel::Technical;
    assert_eq!(
        crate::review_documents::verify(&workspace, &selection).unwrap(),
        "simple"
    );
    selection.snapshot_id = "another capture".into();
    assert!(crate::review_documents::verify(&workspace, &selection).is_err());
}
