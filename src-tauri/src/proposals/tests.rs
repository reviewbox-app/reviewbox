use super::*;
use std::{fs, path::Path, process::Command};

fn git(root: &Path, args: &[&str]) {
    assert!(
        Command::new("git")
            .current_dir(root)
            .args(args)
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
    fs::write(root.join("code.ts"), "const answer = 1;\n").unwrap();
    git(&root, &["add", "."]);
    git(&root, &["commit", "-qm", "initial"]);
    fs::write(root.join("code.ts"), "const answer = 2;\n").unwrap();
    let storage = Storage::open(dir.path().join("data")).unwrap();
    let repository = crate::repositories::open(&storage, root.to_str().unwrap()).unwrap();
    let workspace = reviews::create(
        &storage,
        CaptureRequest {
            repository_id: repository.id,
            scope: Scope::Local,
            base: None,
            target: None,
            include_untracked: false,
        },
    )
    .unwrap();
    (dir, storage, workspace)
}

#[test]
fn draft_anchor_diagnostics_allow_repair_but_never_allow_invalid_application() {
    let (_dir, storage, workspace) = fixture();
    let topic = Topic {
        id: "topic".into(),
        title: "Check answer".into(),
        brief: "Verify the value".into(),
        steps: vec![Step {
            id: "step".into(),
            title: "Read assignment".into(),
            documents: {
                let doc = ReviewDocument {
                    term_aliases: Default::default(),
                    body: "Check behavior".into(),
                    references: vec![],
                    terms: vec![],
                    reading_seconds: 10,
                };
                LevelDocuments {
                    single: None,
                    dependencies: None,
                    context_sources: vec![],
                    glossary: vec![],
                    essential: doc.clone(),
                    explained: doc.clone(),
                    technical: doc,
                }
            },
            anchors: vec![CodeAnchor {
                snapshot_id: workspace.snapshot.id.clone(),
                change_id: "invented".into(),
                passage_id: "invented".into(),
            }],
        }],
    };
    let mut content = ProposalContent::Topics {
        topics: vec![topic],
    };
    let proposal = parse(
        &storage,
        &workspace.review.id,
        &serde_json::to_string(&content).unwrap(),
        None,
    )
    .unwrap();
    let issues = diagnostics(&storage, &workspace.review.id, &content).unwrap();
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].anchor_index, Some(0));
    assert!(answer(&storage, &proposal.id, 0, content.clone(), true).is_err());
    assert!(
        reviews::load(&storage, &workspace.review.id)
            .unwrap()
            .review
            .topics
            .is_empty()
    );
    let ProposalContent::Topics { topics } = &mut content else {
        unreachable!()
    };
    topics[0].steps[0].anchors[0] = CodeAnchor {
        snapshot_id: workspace.snapshot.id.clone(),
        change_id: workspace.snapshot.changes[0].id.clone(),
        passage_id: workspace.snapshot.changes[0].passages[0].id.clone(),
    };
    assert!(
        diagnostics(&storage, &workspace.review.id, &content)
            .unwrap()
            .is_empty()
    );
    answer(&storage, &proposal.id, 0, content, true).unwrap();
    let review = reviews::load(&storage, &workspace.review.id)
        .unwrap()
        .review;
    assert_eq!(review.topics.len(), 1);
    assert!(review.decisions.is_empty());
    assert!(review.examined.is_empty());
}

#[test]
fn preparation_scope_includes_deleted_binary_and_large_changes_without_curating_context() {
    let (_dir, storage, old) = fixture();
    let repository: Repository = storage
        .get("repository", &old.review.repository_id)
        .unwrap();
    let root = Path::new(&repository.path);
    fs::remove_file(root.join("code.ts")).unwrap();
    fs::write(root.join(".env.local"), "A=secret").unwrap();
    fs::write(root.join("binary.bin"), [0, 1, 2]).unwrap();
    fs::write(root.join("large.txt"), vec![b'a'; 129 * 1024]).unwrap();
    let workspace = reviews::create(
        &storage,
        CaptureRequest {
            repository_id: repository.id,
            scope: Scope::Local,
            base: None,
            target: None,
            include_untracked: true,
        },
    )
    .unwrap();
    let context = crate::agents::preparation_context(&storage, &workspace.review.id).unwrap();
    assert_eq!(context.changed_files, 4);
    assert_eq!(context.snapshot_id, workspace.snapshot.id);
    assert_eq!(context.project_path, root.to_string_lossy());
}

#[test]
fn agent_enrichment_and_new_proposals_cannot_modify_completed_reviews() {
    let (dir, storage, workspace) = fixture();
    let content = serde_json::json!({"kind":"explanation","path":"code.ts","sections":[{"id":"section","title":"Answer","body":"Read the assignment.","startLine":1,"endLine":1}]});
    let proposal = parse(&storage, &workspace.review.id, &content.to_string(), None).unwrap();
    let completed = reviews::apply(
        &storage,
        &workspace.review.id,
        workspace.review.revision,
        ReviewAction::CompleteManualReview,
    )
    .unwrap();
    assert_eq!(
        parse(&storage, &workspace.review.id, &content.to_string(), None)
            .unwrap_err()
            .code,
        "immutable_review"
    );
    assert_eq!(
        answer(
            &storage,
            &proposal.id,
            proposal.revision,
            proposal.content,
            true
        )
        .unwrap_err()
        .code,
        "immutable_review"
    );
    for method in ["propose", "enrich", "completeManualReview", "validateStep"] {
        let result = crate::integrations::dispatch(
            &storage,
            serde_json::json!({"method": method, "repo":dir.path().join("repo"), "reviewId":workspace.review.id,"snapshotId":workspace.snapshot.id,"content":content}),
        );
        assert!(result.is_err());
    }
    assert_eq!(
        reviews::load(&storage, &completed.review.id)
            .unwrap()
            .review
            .publication,
        completed.review.publication
    );
}
