use super::*;
use crate::repositories;
use std::{fs, process::Command};
fn command(path: &std::path::Path, args: &[&str]) {
    assert!(
        Command::new("git")
            .args(args)
            .current_dir(path)
            .output()
            .unwrap()
            .status
            .success()
    );
}
fn fixture() -> (tempfile::TempDir, Storage, Repository) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("repo");
    fs::create_dir(&root).unwrap();
    command(&root, &["init", "-q"]);
    command(&root, &["config", "user.email", "test@example.invalid"]);
    command(&root, &["config", "user.name", "Test"]);
    fs::write(root.join("a.ts"), "const a = 1;\nconst b = 2;\n").unwrap();
    command(&root, &["add", "."]);
    command(&root, &["commit", "-qm", "initial"]);
    let storage = Storage::open(dir.path().join("data")).unwrap();
    let repo = repositories::open(&storage, root.to_str().unwrap()).unwrap();
    (dir, storage, repo)
}
#[test]
fn partial_staging_survives_and_questions_block_completion() {
    let (_dir, storage, repo) = fixture();
    let root = std::path::Path::new(&repo.path);
    fs::write(root.join("a.ts"), "const a = 3;\nconst b = 2;\n").unwrap();
    command(root, &["add", "a.ts"]);
    fs::write(root.join("a.ts"), "const a = 1;\nconst b = 2;\n").unwrap();
    let mut w = create(
        &storage,
        CaptureRequest {
            repository_id: repo.id,
            scope: Scope::Local,
            base: None,
            target: None,
            include_untracked: false,
        },
    )
    .unwrap();
    assert_eq!(w.snapshot.changes.len(), 2);
    let anchors: Vec<_> = w
        .snapshot
        .changes
        .iter()
        .flat_map(|c| {
            c.passages.iter().map(|p| CodeAnchor {
                snapshot_id: w.snapshot.id.clone(),
                change_id: c.id.clone(),
                passage_id: p.id.clone(),
            })
        })
        .collect();
    for anchor in &anchors {
        w = apply(
            &storage,
            &w.review.id,
            w.review.revision,
            ReviewAction::Validate {
                anchor: anchor.clone(),
            },
        )
        .unwrap();
    }
    assert!(coverage(&w).complete);
    w = apply(
        &storage,
        &w.review.id,
        w.review.revision,
        ReviewAction::AddAnnotation {
            anchor: anchors[0].clone(),
            body: "Why?".into(),
            question: true,
        },
    )
    .unwrap();
    assert!(!coverage(&w).complete);
    assert_eq!(coverage(&w).validated, 2);
    let frozen = snapshots::content(&storage, &w.snapshot.id, &w.snapshot.changes[0].id).unwrap();
    fs::write(root.join("a.ts"), "changed again").unwrap();
    assert_eq!(
        frozen.after,
        snapshots::content(&storage, &w.snapshot.id, &w.snapshot.changes[0].id)
            .unwrap()
            .after
    );
    let next = refresh(&storage, &w.review.id, w.review.revision).unwrap();
    assert_eq!(coverage(&next).validated, 1);
    assert_eq!(next.review.previous_snapshot_ids.len(), 1);
}
#[test]
fn optimistic_revision_does_not_overwrite() {
    let (_dir, s, r) = fixture();
    let w = create(
        &s,
        CaptureRequest {
            repository_id: r.id,
            scope: Scope::Local,
            base: None,
            target: None,
            include_untracked: false,
        },
    )
    .unwrap();
    apply(
        &s,
        &w.review.id,
        0,
        ReviewAction::Rename {
            title: "First".into(),
        },
    )
    .unwrap();
    assert!(
        apply(
            &s,
            &w.review.id,
            0,
            ReviewAction::Rename {
                title: "Second".into()
            }
        )
        .is_err()
    );
    assert_eq!(load(&s, &w.review.id).unwrap().review.title, "First");
}
#[test]
fn blob_integrity_and_persistence() {
    let (dir, s, r) = fixture();
    let blob = s.blob(b"secret-free test", "100644".into()).unwrap();
    assert!(Storage::open(dir.path().join("data")).is_err());
    let stored_hash = blob.hash;
    drop(s);
    let reopened = Storage::open(dir.path().join("data")).unwrap();
    assert_eq!(
        reopened
            .get::<Repository>("repository", &r.id)
            .unwrap()
            .path,
        r.path
    );
    fs::write(
        reopened.root().join("blobs").join(&stored_hash),
        b"corrupted",
    )
    .unwrap();
    assert!(reopened.read_blob(&stored_hash).is_err());
}

#[test]
fn nested_deletion_and_untracked_opt_in() {
    let (_dir, storage, repo) = fixture();
    let root = std::path::Path::new(&repo.path);
    fs::create_dir(root.join("nested")).unwrap();
    fs::write(root.join("nested/gone.txt"), "before").unwrap();
    command(root, &["add", "."]);
    command(root, &["commit", "-qm", "nested"]);
    fs::remove_dir_all(root.join("nested")).unwrap();
    fs::write(root.join("new.txt"), "untracked").unwrap();
    let request = CaptureRequest {
        repository_id: repo.id,
        scope: Scope::Local,
        base: None,
        target: None,
        include_untracked: false,
    };
    let without = create(&storage, request.clone()).unwrap();
    assert_eq!(without.snapshot.changes.len(), 1);
    assert!(without.snapshot.changes[0].after.is_none());
    let with = create(
        &storage,
        CaptureRequest {
            include_untracked: true,
            ..request
        },
    )
    .unwrap();
    assert_eq!(with.snapshot.changes.len(), 2);
}
#[test]
fn invalid_anchors_and_duplicate_coverage() {
    let (_dir, storage, repo) = fixture();
    fs::write(std::path::Path::new(&repo.path).join("a.ts"), "new code").unwrap();
    let mut w = create(
        &storage,
        CaptureRequest {
            repository_id: repo.id,
            scope: Scope::Local,
            base: None,
            target: None,
            include_untracked: false,
        },
    )
    .unwrap();
    let change = &w.snapshot.changes[0];
    let anchor = CodeAnchor {
        snapshot_id: w.snapshot.id.clone(),
        change_id: change.id.clone(),
        passage_id: change.passages[0].id.clone(),
    };
    let topics = (0..2)
        .map(|index| Topic {
            id: format!("topic{index}"),
            title: "Topic".into(),
            brief: "".into(),
            steps: vec![Step {
                id: format!("step{index}"),
                title: "Read".into(),
                explanation: "".into(),
                anchors: vec![anchor.clone()],
            }],
        })
        .collect();
    w = apply(
        &storage,
        &w.review.id,
        0,
        ReviewAction::SaveTopics { topics },
    )
    .unwrap();
    let coverage = coverage(&w);
    assert_eq!(coverage.total, 1);
    assert_eq!(coverage.outside, 0);
    let invalid = CodeAnchor {
        snapshot_id: "another-snapshot".into(),
        ..anchor
    };
    assert!(
        apply(
            &storage,
            &w.review.id,
            w.review.revision,
            ReviewAction::Validate { anchor: invalid }
        )
        .is_err()
    );
}
#[test]
fn tour_roundtrip_imports_no_decisions_or_private_notes() {
    let (_dir, storage, repo) = fixture();
    fs::write(std::path::Path::new(&repo.path).join("a.ts"), "changed").unwrap();
    let mut w = create(
        &storage,
        CaptureRequest {
            repository_id: repo.id,
            scope: Scope::Local,
            base: None,
            target: None,
            include_untracked: false,
        },
    )
    .unwrap();
    let c = &w.snapshot.changes[0];
    let anchor = CodeAnchor {
        snapshot_id: w.snapshot.id.clone(),
        change_id: c.id.clone(),
        passage_id: c.passages[0].id.clone(),
    };
    w = apply(
        &storage,
        &w.review.id,
        0,
        ReviewAction::SaveTopics {
            topics: vec![Topic {
                id: "topic".into(),
                title: "Read this".into(),
                brief: "".into(),
                steps: vec![Step {
                    id: "step".into(),
                    title: "Change".into(),
                    explanation: "Public explanation".into(),
                    anchors: vec![anchor.clone()],
                }],
            }],
        },
    )
    .unwrap();
    w = apply(
        &storage,
        &w.review.id,
        w.review.revision,
        ReviewAction::AddAnnotation {
            anchor,
            body: "PRIVATE_MARKER".into(),
            question: false,
        },
    )
    .unwrap();
    let export = crate::tours::export(&storage, &w.review.id).unwrap();
    assert!(!export.contains("PRIVATE_MARKER"));
    let imported =
        crate::tours::import(&storage, &w.review.id, w.review.revision, &export).unwrap();
    assert_eq!(imported.review.topics.len(), 2);
    assert!(imported.review.decisions.is_empty());
    assert_eq!(imported.review.annotations.len(), 1);
}

#[test]
fn proposals_are_atomic_bound_to_content_and_never_validate() {
    let (_dir, storage, repo) = fixture();
    fs::write(
        std::path::Path::new(&repo.path).join("a.ts"),
        "const a = 7;\n",
    )
    .unwrap();
    let w = create(
        &storage,
        CaptureRequest {
            repository_id: repo.id,
            scope: Scope::Local,
            base: None,
            target: None,
            include_untracked: false,
        },
    )
    .unwrap();
    let content = ProposalContent::Topics {
        topics: vec![Topic {
            id: "t".into(),
            title: "One".into(),
            brief: "Purpose".into(),
            steps: vec![Step {
                id: "s".into(),
                title: "Read".into(),
                explanation: "Check behavior".into(),
                anchors: vec![CodeAnchor {
                    snapshot_id: w.snapshot.id.clone(),
                    change_id: w.snapshot.changes[0].id.clone(),
                    passage_id: w.snapshot.changes[0].passages[0].id.clone(),
                }],
            }],
        }],
    };
    let text = serde_json::to_string(&content).unwrap();
    let proposal = crate::proposals::parse(&storage, &w.review.id, &text, None).unwrap();
    assert!(
        load(&storage, &w.review.id)
            .unwrap()
            .review
            .topics
            .is_empty()
    );
    crate::proposals::answer(&storage, &proposal.id, 0, content.clone(), true).unwrap();
    assert!(crate::proposals::answer(&storage, &proposal.id, 0, content.clone(), true).is_err());
    let current = load(&storage, &w.review.id).unwrap();
    assert_eq!(current.review.topics.len(), 1);
    assert!(current.review.decisions.is_empty());
    let next = crate::proposals::parse(&storage, &w.review.id, &text, None).unwrap();
    refresh(&storage, &w.review.id, current.review.revision).unwrap();
    assert!(crate::proposals::answer(&storage, &next.id, 0, content, true).is_err());
    let pending: Proposal = storage.get("proposal", &next.id).unwrap();
    assert_eq!(pending.status, "pending");
    assert!(
        crate::proposals::parse(
            &storage,
            &w.review.id,
            r#"{"kind":"validate","anchor":{}}"#,
            None
        )
        .is_err()
    );
}
#[test]
fn changing_only_index_invalidates_the_repository_marker() {
    let (_dir, storage, repo) = fixture();
    let root = std::path::Path::new(&repo.path);
    fs::write(root.join("a.ts"), "new content").unwrap();
    let w = create(
        &storage,
        CaptureRequest {
            repository_id: repo.id.clone(),
            scope: Scope::Local,
            base: None,
            target: None,
            include_untracked: false,
        },
    )
    .unwrap();
    assert!(!snapshots::repository_changed(&storage, &w.snapshot).unwrap());
    command(root, &["add", "a.ts"]);
    assert!(snapshots::repository_changed(&storage, &w.snapshot).unwrap());
}

#[test]
fn onboarding_relocates_exact_text_and_imports_only_supported_codetour_steps() {
    let (_dir, storage, repo) = fixture();
    let text = r#"{"title":"Learn","ref":"older-commit","steps":[{"title":"Read","file":"a.ts","line":1,"description":"Read the constant","commands":["not-executed"]},{"file":"../outside","line":1,"description":"No"},{"directory":"src","description":"Not a file"}]}"#;
    let report = crate::onboarding::import(&storage, &repo.id, text).unwrap();
    assert_eq!(report.tour.steps.len(), 1);
    assert!(report.warnings.len() >= 4);
    assert!(
        storage
            .list::<OnboardingTour>("onboarding")
            .unwrap()
            .is_empty()
    );
    let tour = crate::onboarding::save(&storage, report.tour).unwrap();
    let step = &tour.steps[0];
    assert_eq!(
        crate::onboarding::read_step(&storage, &tour.id, &step.id)
            .unwrap()
            .status,
        "current"
    );
    fs::write(
        std::path::Path::new(&repo.path).join("a.ts"),
        "// inserted\nconst a = 1;\nconst b = 2;\n",
    )
    .unwrap();
    let moved = crate::onboarding::read_step(&storage, &tour.id, &step.id).unwrap();
    assert_eq!(moved.status, "relocated");
    assert_eq!(moved.start_line, 2);
    fs::write(
        std::path::Path::new(&repo.path).join("a.ts"),
        "different content\n",
    )
    .unwrap();
    assert_eq!(
        crate::onboarding::read_step(&storage, &tour.id, &step.id)
            .unwrap()
            .status,
        "stale"
    );
}
#[test]
fn startup_revokes_unfinished_test_permissions() {
    let (dir, storage, repo) = fixture();
    let w = create(
        &storage,
        CaptureRequest {
            repository_id: repo.id,
            scope: Scope::Local,
            base: None,
            target: None,
            include_untracked: false,
        },
    )
    .unwrap();
    let run =
        crate::evidence::prepare(&storage, &w.review.id, vec!["printf".into(), "test".into()])
            .unwrap();
    drop(storage);
    let reopened = Storage::open(dir.path().join("data")).unwrap();
    let interrupted: TestRun = reopened.get("test_run", &run.id).unwrap();
    assert_eq!(interrupted.status, "interrupted");
    assert!(!interrupted.snapshot_matches);
}

#[test]
fn unborn_repository_root_commit_binary_and_unicode_paths() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("repo");
    fs::create_dir(&root).unwrap();
    command(&root, &["init", "-q"]);
    command(&root, &["config", "user.email", "test@example.invalid"]);
    command(&root, &["config", "user.name", "Test"]);
    let storage = Storage::open(dir.path().join("data")).unwrap();
    let repo = repositories::open(&storage, root.to_str().unwrap()).unwrap();
    let request = CaptureRequest {
        repository_id: repo.id,
        scope: Scope::Local,
        base: None,
        target: None,
        include_untracked: false,
    };
    let empty = create(&storage, request.clone()).unwrap();
    assert!(empty.snapshot.changes.is_empty());
    fs::write(root.join("été file.bin"), [0, 1, 2]).unwrap();
    command(&root, &["add", "."]);
    let staged = create(&storage, request.clone()).unwrap();
    assert_eq!(staged.snapshot.changes.len(), 1);
    assert!(staged.snapshot.changes[0].binary);
    assert!(
        snapshots::content(
            &storage,
            &staged.snapshot.id,
            &staged.snapshot.changes[0].id
        )
        .unwrap()
        .unavailable_reason
        .is_some()
    );
    command(&root, &["commit", "-qm", "root"]);
    let committed = create(
        &storage,
        CaptureRequest {
            scope: Scope::Commit,
            ..request
        },
    )
    .unwrap();
    assert_eq!(committed.snapshot.changes.len(), 1);
}
#[test]
fn refreshing_preserves_historical_review_aggregate() {
    let (_dir, storage, repo) = fixture();
    fs::write(std::path::Path::new(&repo.path).join("a.ts"), "changed\n").unwrap();
    let w = create(
        &storage,
        CaptureRequest {
            repository_id: repo.id,
            scope: Scope::Local,
            base: None,
            target: None,
            include_untracked: false,
        },
    )
    .unwrap();
    let next = refresh(&storage, &w.review.id, w.review.revision).unwrap();
    let old: Review = storage
        .get(
            "review_history",
            &format!("{}@{}", w.review.id, w.review.revision),
        )
        .unwrap();
    assert_eq!(old.snapshot_id, w.snapshot.id);
    assert_ne!(next.snapshot.id, old.snapshot_id);
}
