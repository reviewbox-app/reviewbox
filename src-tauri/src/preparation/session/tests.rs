use super::*;
fn plan() -> Value {
    json!({"requestId":"plan","revision":0,"steps":[{"id":"amount","title":"Amount"}]})
}
fn document(workspace: &Workspace) -> Value {
    let change = &workspace.snapshot.changes[0];
    json!({"requestId":"document","revision":1,"stepId":"amount","anchors":[{"snapshotId":workspace.snapshot.id,"changeId":change.id,"passageId":change.passages[0].id}],"document":{"body":"The amount is now two.","references":[],"terms":[],"readingSeconds":1}})
}
#[test]
fn mutations_are_recoverable_idempotent_and_finish_is_explicit() {
    let (_dir, storage, workspace) = crate::preparation::tests::native::fixture();
    let mut draft = Draft::default();
    assert!(
        draft
            .call(
                "review_document",
                document(&workspace),
                &storage,
                &workspace,
                None
            )
            .is_err()
    );
    let first = draft
        .call("review_plan", plan(), &storage, &workspace, None)
        .unwrap();
    assert_eq!(
        draft
            .call("review_plan", plan(), &storage, &workspace, None)
            .unwrap(),
        first
    );
    assert!(
        draft
            .call(
                "review_finish",
                json!({"requestId":"early","revision":1,"summary":"done"}),
                &storage,
                &workspace,
                None
            )
            .is_err()
    );
    let args = document(&workspace);
    let result = draft
        .call("review_document", args.clone(), &storage, &workspace, None)
        .unwrap();
    let encoded = serde_json::to_value(&draft).unwrap();
    assert!(encoded["documents"]["amount"].get("essential").is_none());
    assert_eq!(encoded["documents"]["amount"]["single"]["version"], 1);
    let mut recovered: Draft = serde_json::from_value(encoded).unwrap();
    assert_eq!(
        recovered
            .call("review_document", args, &storage, &workspace, None)
            .unwrap(),
        result
    );
    assert_eq!(recovered.revision, 2);
    recovered
        .call(
            "review_finish",
            json!({"requestId":"finish","revision":2,"summary":"Ready for human review."}),
            &storage,
            &workspace,
            None,
        )
        .unwrap();
    assert!(recovered.finished);
    assert_eq!(recovered.topics().len(), 1);
    assert!(
        reviews::load(&storage, &workspace.review.id)
            .unwrap()
            .review
            .topics
            .is_empty()
    );
}
#[test]
fn plan_changes_require_explicit_removal_and_revision() {
    let (_dir, storage, workspace) = crate::preparation::tests::native::fixture();
    let mut draft = Draft::default();
    draft
        .call("review_plan", plan(), &storage, &workspace, None)
        .unwrap();
    assert!(
        draft
            .call(
                "review_plan",
                json!({"requestId":"plan2","revision":1,"steps":[]}),
                &storage,
                &workspace,
                None
            )
            .is_err()
    );
    assert!(
        draft
            .call(
                "review_decide",
                json!({"requestId":"remove","revision":0,"stepId":"amount","decision":"remove"}),
                &storage,
                &workspace,
                None
            )
            .is_err()
    );
    draft
        .call(
            "review_decide",
            json!({"requestId":"remove","revision":1,"stepId":"amount","decision":"remove"}),
            &storage,
            &workspace,
            None,
        )
        .unwrap();
    draft
        .call(
            "review_plan",
            json!({"requestId":"plan2","revision":2,"steps":[]}),
            &storage,
            &workspace,
            None,
        )
        .unwrap();
    assert!(draft.steps.is_empty());
}
#[test]
fn captured_references_cannot_escape_the_operation() {
    let (_dir, storage, workspace) = crate::preparation::tests::native::fixture();
    let mut draft = Draft::default();
    draft
        .call("review_plan", plan(), &storage, &workspace, None)
        .unwrap();
    let mut args = document(&workspace);
    args["anchors"][0]["snapshotId"] = json!("other-capture");
    assert!(
        draft
            .call("review_document", args, &storage, &workspace, None)
            .is_err()
    );
    assert_eq!(draft.revision, 1);
    assert!(draft.documents.is_empty());
}
#[test]
fn updates_require_decisions_and_reject_stale_or_restyled_retention() {
    let (_dir, storage, mut previous) = crate::preparation::tests::native::fixture();
    let mut initial = Draft::default();
    initial
        .call("review_plan", plan(), &storage, &previous, None)
        .unwrap();
    initial
        .call(
            "review_document",
            document(&previous),
            &storage,
            &previous,
            None,
        )
        .unwrap();
    previous.review.topics = initial.topics();
    let current = previous.clone();
    let mut update = Draft::default();
    update.call("review_plan", json!({"requestId":"plan","revision":0,"steps":[{"id":"next","title":"Amount","previousStepId":"amount"}]}), &storage, &current, Some(&previous)).unwrap();
    assert!(
        update
            .call(
                "review_finish",
                json!({"requestId":"early","revision":1}),
                &storage,
                &current,
                Some(&previous)
            )
            .is_err()
    );
    update
        .call(
            "review_decide",
            json!({"requestId":"keep","revision":1,"stepId":"next","decision":"keep"}),
            &storage,
            &current,
            Some(&previous),
        )
        .unwrap();
    assert_eq!(update.topics()[0].steps[0].id, "amount");
    assert_eq!(
        update.topics()[0].steps[0]
            .documents
            .get(ReadingLevel::Essential)
            .body,
        "The amount is now two."
    );
    update
        .call(
            "review_finish",
            json!({"requestId":"done","revision":2}),
            &storage,
            &current,
            Some(&previous),
        )
        .unwrap();
    let step = &previous.review.topics[0].steps[0];
    let mut stale = current.snapshot.clone();
    stale.changes[0].path = "different.ts".into();
    assert!(retained(&previous, &stale, step, &ReviewWritingProfile::default()).is_none());
    let technical = ReviewWritingProfile {
        style: ReviewWritingStyle::Technical,
        instructions: String::new(),
    };
    assert!(retained(&previous, &current.snapshot, step, &technical).is_none());
    let mut omitted = Draft::default();
    omitted
        .call(
            "review_plan",
            json!({"requestId":"plan","revision":0,"steps":[]}),
            &storage,
            &current,
            Some(&previous),
        )
        .unwrap();
    assert!(
        omitted
            .call(
                "review_finish",
                json!({"requestId":"finish","revision":1}),
                &storage,
                &current,
                Some(&previous)
            )
            .is_err()
    );
    omitted
        .call(
            "review_decide",
            json!({"requestId":"remove","revision":1,"stepId":"amount","decision":"remove"}),
            &storage,
            &current,
            Some(&previous),
        )
        .unwrap();
    omitted
        .call(
            "review_finish",
            json!({"requestId":"finish","revision":2}),
            &storage,
            &current,
            Some(&previous),
        )
        .unwrap();
    assert!(omitted.topics().is_empty());
}
#[test]
fn legacy_documents_stay_readable_and_custom_requires_instructions() {
    let (_dir, storage, workspace) = crate::preparation::tests::native::fixture();
    let mut draft = Draft {
        profile: ReviewWritingProfile {
            style: ReviewWritingStyle::Custom,
            instructions: String::new(),
        },
        ..Default::default()
    };
    draft
        .call("review_plan", plan(), &storage, &workspace, None)
        .unwrap();
    assert!(
        draft
            .call(
                "review_document",
                document(&workspace),
                &storage,
                &workspace,
                None
            )
            .is_err()
    );
    let doc = json!({"body":"old","references":[],"terms":[],"readingSeconds":1});
    let legacy: LevelDocuments =
        serde_json::from_value(json!({"essential":doc,"explained":doc,"technical":doc})).unwrap();
    assert_eq!(legacy.get(ReadingLevel::Essential).body, "old");
    assert!(legacy.single.is_none());
}
