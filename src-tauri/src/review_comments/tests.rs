use super::*;

fn anchor() -> ReviewCommentAnchor {
    ReviewCommentAnchor {
        snapshot_id: "snapshot".into(),
        source_id: "change:file:before".into(),
        path: "deleted.ts".into(),
        content_hash: "hash".into(),
        range: ReviewCommentRange {
            start_line: 1,
            start_column: 1,
            end_line: 1,
            end_column: 3,
        },
        excerpt: "hi".into(),
    }
}
fn add(id: &str, text: &str) -> ReviewCommentMutation {
    ReviewCommentMutation::Add {
        id: id.into(),
        anchor: anchor(),
        text: text.into(),
    }
}
#[test]
fn markdown_crud_preserves_prose_other_reviews_and_resolution() {
    let original = "# My notes\n\nKeep this prose.\n";
    let first = update_text(
        original,
        "review-a",
        add("first", "Please preserve\nUnicode: 日本語"),
    )
    .unwrap();
    let both = update_text(&first, "review-b", add("second", "Other review")).unwrap();
    let edited = update_text(
        &both,
        "review-a",
        ReviewCommentMutation::Edit {
            id: "first".into(),
            text: "Still important".into(),
            status: ReviewCommentStatus::Addressed,
            resolution: "Handled missing values".into(),
            tests: "bun test: 2 passed".into(),
        },
    )
    .unwrap();
    let parsed = parse(&edited).unwrap();
    assert_eq!(parsed.len(), 2);
    assert_eq!(parsed[0].comment.status, ReviewCommentStatus::Addressed);
    assert_eq!(parsed[0].comment.resolution, "Handled missing values");
    assert_eq!(parsed[0].comment.tests, "bun test: 2 passed");
    assert_eq!(parsed[1].comment.review_id, "review-b");
    assert!(edited.starts_with(original));
    let deleted = update_text(
        &edited,
        "review-a",
        ReviewCommentMutation::Delete { id: "first".into() },
    )
    .unwrap();
    assert_eq!(parse(&deleted).unwrap().len(), 1);
    assert!(deleted.starts_with(original));
    assert!(deleted.contains("Other review"));
}
#[test]
fn retries_are_idempotent_and_foreign_ids_are_rejected() {
    let first = update_text("", "review", add("same", "Comment\n")).unwrap();
    assert_eq!(
        update_text(&first, "review", add("same", "Comment\n")).unwrap(),
        first
    );
    assert!(update_text(&first, "other", add("same", "Comment")).is_err());
    assert_eq!(
        update_text(
            &first,
            "other",
            ReviewCommentMutation::Delete { id: "same".into() }
        )
        .unwrap(),
        first
    );
}
#[test]
fn malformed_blocks_and_reserved_markers_are_not_rewritten() {
    let first = update_text("", "review", add("same", "Comment")).unwrap();
    assert!(parse(&first.replace("<!-- REVIEWBOX_END#same -->", "")).is_err());
    assert!(parse(&format!("{first}{first}")).is_err());
    assert!(update_text("", "review", add("same", "<!-- REVIEWBOX_START#oops")).is_err());
    assert!(update_text("", "review", add("same", "  ")).is_err());
}
#[test]
fn source_ranges_use_utf16_crlf_bom_and_exclusive_end() {
    let source = "\u{feff}a😀b\r\nsecond\r\n";
    let range = ReviewCommentRange {
        start_line: 1,
        start_column: 2,
        end_line: 2,
        end_column: 4,
    };
    assert_eq!(selected_text(source, &range).unwrap(), "😀b\nsec");
    assert!(
        selected_text(
            source,
            &ReviewCommentRange {
                start_column: 3,
                ..range.clone()
            }
        )
        .is_err()
    );
    assert!(
        selected_text(
            source,
            &ReviewCommentRange {
                end_line: 99,
                ..range.clone()
            }
        )
        .is_err()
    );
    assert!(
        selected_text(
            source,
            &ReviewCommentRange {
                end_line: 1,
                end_column: 2,
                ..range
            }
        )
        .is_err()
    );
}
#[test]
fn external_body_edits_remain_authoritative() {
    let first = update_text("", "review", add("same", "Original text")).unwrap();
    let changed = first.replace("Original text", "Edited outside the app\nwith more details");
    assert_eq!(
        parse(&changed).unwrap()[0].comment.text,
        "Edited outside the app\nwith more details"
    );
}
#[test]
fn only_the_private_markdown_path_is_written() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("source.ts"), "const value = 1;\n").unwrap();
    let project = Project::open(dir.path(), "checkout").unwrap();
    let _lock = project.lock().unwrap();
    let notes = update_text("", "review", add("id", "Comment on a deleted file")).unwrap();
    let path = project_storage::checked(&project.root, FILE).unwrap();
    project_storage::atomic(&path, notes.as_bytes()).unwrap();
    assert_eq!(read_text(&path).unwrap(), notes);
    assert_eq!(
        fs::read_to_string(dir.path().join("source.ts")).unwrap(),
        "const value = 1;\n"
    );
    assert!(!project.root.join("REVIEW_COMMENTS.md").exists());
}
