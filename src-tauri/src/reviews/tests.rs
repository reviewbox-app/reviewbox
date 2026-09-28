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
        glossary: vec![],
        beginner: d.clone(),
        intermediate: d.clone(),
        developer: d,
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
            level: ReadingLevel::Developer,
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
fn manual_file_covers_both_layers_and_intermediate_requires_pseudocode() {
    let (_d, s, w) = fixture();
    let file = w.review.files.iter().find(|f| f.path == "a.ts").unwrap();
    assert_eq!(file.change_ids.len(), 2);
    assert!(
        apply(
            &s,
            &w.review.id,
            w.review.revision,
            ReviewAction::ValidateFile {
                file_id: file.id.clone(),
                level: ReadingLevel::Intermediate
            }
        )
        .is_err()
    );
    let next = apply(
        &s,
        &w.review.id,
        w.review.revision,
        ReviewAction::ValidateFile {
            file_id: file.id.clone(),
            level: ReadingLevel::Developer,
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
            level: ReadingLevel::Developer,
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
            pseudocode_selected: None,
            pseudocode_skip_reason: None,
            file_id: f.id.clone(),
            documents: Some(docs()),
            translations: f
                .translations
                .iter()
                .map(|t| PseudoTranslation {
                    source_id: t.source_id.clone(),
                    source_hash: t.source_hash.clone(),
                    blocks: vec![],
                    unavailable_reason: Some("Not translated".into()),
                })
                .collect(),
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
        "repo/.reviewbox/generated/{}/prepared/0001.json",
        w.review.id
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
fn intermediate_validation_requires_and_accepts_complete_translations() {
    let (_d, s, w) = fixture();
    let w = guided(&s, w);
    let contents = w
        .review
        .files
        .iter()
        .map(|f| ReviewFileContent {
            pseudocode_selected: None,
            pseudocode_skip_reason: None,
            file_id: f.id.clone(),
            documents: Some(docs()),
            translations: f
                .translations
                .iter()
                .map(|t| {
                    let text = crate::reader::source(&s, &w.snapshot, &t.source_id)
                        .unwrap()
                        .text
                        .unwrap();
                    PseudoTranslation {
                        source_id: t.source_id.clone(),
                        source_hash: t.source_hash.clone(),
                        blocks: vec![PseudoBlock {
                            start_line: 1,
                            end_line: text.lines().count().max(1) as u32,
                            text: "assigner une valeur".into(),
                        }],
                        unavailable_reason: None,
                    }
                })
                .collect(),
        })
        .collect();
    let w = crate::reader::publish_preparation(
        &s,
        &w.review.id,
        &w.snapshot.id,
        "translated",
        w.review.revision,
        w.review.topics.clone(),
        contents,
    )
    .unwrap();
    assert_eq!(
        w.review.topics[0].steps[0]
            .documents
            .beginner
            .reading_seconds,
        1
    );
    assert_eq!(
        crate::reader::read_file(&s, &w.review.id, &crate::reader::file_id("a.ts"))
            .unwrap()
            .documents
            .unwrap()
            .beginner
            .reading_seconds,
        1
    );
    let next = apply(
        &s,
        &w.review.id,
        w.review.revision,
        ReviewAction::ValidateFile {
            file_id: crate::reader::file_id("a.ts"),
            level: ReadingLevel::Intermediate,
        },
    )
    .unwrap();
    assert_eq!(next.review.decisions.len(), 1);
}
#[test]
fn beginner_identifiers_are_allowed_and_invalid_reference_ids_are_rejected() {
    let (_d, s, w) = fixture();
    let mut documents = docs();
    documents.beginner.body = "Look at `const`".into();
    crate::reader::validate_documents(&s, &w.snapshot, &documents).unwrap();
    let mut documents = docs();
    documents.developer.references.push(DocumentReference {
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
        documents.developer.body = format!("{marker}source\nmissing\n{marker}");
        assert!(crate::reader::validate_documents(&s, &w.snapshot, &documents).is_err());
        documents.developer.references.push(DocumentReference {
            id: "missing".into(),
            label: "Source".into(),
            explanation: "Captured line".into(),
            source_id: crate::reader::sources(&w.snapshot)[0].source_id.clone(),
            start_line: 1,
            end_line: 1,
        });
        crate::reader::validate_documents(&s, &w.snapshot, &documents).unwrap();
        documents.beginner.body = format!("{marker}rust\nlet source = true;\n{marker}");
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
    assert_eq!(file.translations.len(), 4);
    let next = apply(
        &s,
        &next.review.id,
        next.review.revision,
        ReviewAction::ValidateFile {
            file_id: file.id.clone(),
            level: ReadingLevel::Developer,
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
    assert!(content.translations.is_empty());
}

#[test]
fn developer_can_acknowledge_frozen_binary_bytes_without_a_text_preview() {
    let (directory, storage, workspace) = fixture();
    fs::write(directory.path().join("repo/image.bin"), [0, 255, 17]).unwrap();
    let workspace = create(&storage, workspace.snapshot.request).unwrap();
    let file = workspace
        .review
        .files
        .iter()
        .find(|f| f.path == "image.bin")
        .unwrap();
    assert!(
        apply(
            &storage,
            &workspace.review.id,
            workspace.review.revision,
            ReviewAction::ValidateFile {
                file_id: file.id.clone(),
                level: ReadingLevel::Intermediate,
            }
        )
        .is_err()
    );
    let next = apply(
        &storage,
        &workspace.review.id,
        workspace.review.revision,
        ReviewAction::ValidateFile {
            file_id: file.id.clone(),
            level: ReadingLevel::Developer,
        },
    )
    .unwrap();
    assert_eq!(next.review.decisions.len(), 1);
}

#[test]
fn refreshing_a_guided_review_invalidates_generated_documents_and_keeps_history() {
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
            level: ReadingLevel::Developer,
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
    assert_eq!(next.review.decisions.len(), 1);
    assert!(matches!(
        next.review.decisions[0].target,
        DecisionTarget::File { .. }
    ));
    let content = crate::reader::read_file(&s, &next.review.id, &next.review.files[0].id).unwrap();
    assert!(content.documents.is_none());
    let history: Review = s
        .get(
            "review_history",
            &format!("{}@{}", w.review.id, w.review.revision),
        )
        .unwrap();
    assert_eq!(history.topics.len(), w.review.topics.len());
    assert_eq!(history.snapshot_id, w.snapshot.id);
    assert_eq!(history.decisions.len(), 2);
}

#[test]
fn large_step_documents_are_packed_lazily_and_history_keeps_their_exact_versions() {
    let (directory, storage, workspace) = fixture();
    let change = &workspace.snapshot.changes[0];
    let anchor = CodeAnchor {
        snapshot_id: workspace.snapshot.id.clone(),
        change_id: change.id.clone(),
        passage_id: change.passages[0].id.clone(),
    };
    let mut documents = docs();
    documents.beginner.body = "The explanation. ".repeat(7500);
    documents.intermediate.body = "Detailed logic. ".repeat(7500);
    documents.developer.body = "Source behavior. ".repeat(7500);
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
    let root = directory.path().join("repo/.reviewbox");
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
    let refreshed = refresh(&storage, &saved.review.id, saved.review.revision).unwrap();
    assert!(refreshed.review.topics.is_empty());
    let history_id = format!("{}@{}", saved.review.id, saved.review.revision);
    let history: Review = storage.get("review_history", &history_id).unwrap();
    assert_eq!(
        serde_json::to_value(history.topics).unwrap(),
        serde_json::to_value(&saved.review.topics).unwrap()
    );
    assert!(
        fs::metadata(root.join(format!("history/{history_id}.json")))
            .unwrap()
            .len()
            < 64 * 1024
    );
    drop(storage);
    let storage = Storage::open(directory.path().join("fresh-cache")).unwrap();
    repositories::open(&storage, directory.path().join("repo").to_str().unwrap()).unwrap();
    let history: Review = storage.get("review_history", &history_id).unwrap();
    assert_eq!(history.topics[0].steps.len(), 48);
    fs::write(&parts[0], "corrupt").unwrap();
    // Scanning unrelated metadata remains lazy, while a requested document fails explicitly.
    let _: Snapshot = storage.get("snapshot", &refreshed.snapshot.id).unwrap();
    assert!(
        load(&storage, &saved.review.id)
            .unwrap()
            .review
            .topics
            .is_empty()
    );
    assert_eq!(
        storage
            .get::<Review>("review_history", &history_id)
            .unwrap_err()
            .code,
        "corrupt_asset"
    );
}
