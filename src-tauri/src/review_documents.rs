//! Exact document identities and UTF-16 source selections shared by notes and Ask Rev.
use crate::contracts::*;

pub(crate) fn step<'a>(review: &'a Review, id: &str) -> AppResult<&'a Step> {
    review
        .topics
        .iter()
        .flat_map(|t| &t.steps)
        .find(|s| s.id == id)
        .ok_or_else(|| {
            AppError::new(
                "document_changed",
                "This step no longer exists. Select the document again.",
            )
        })
}
pub(crate) fn verify(workspace: &Workspace, selection: &DocumentSelection) -> AppResult<String> {
    verify_review(&workspace.review, selection)
}
pub(crate) fn verify_review(review: &Review, selection: &DocumentSelection) -> AppResult<String> {
    if selection.snapshot_id != review.snapshot_id {
        return Err(AppError::new(
            "document_changed",
            "The capture changed. Select the document again.",
        ));
    }
    let doc = step(review, &selection.step_id)?
        .documents
        .get(selection.level);
    if fingerprint(doc.body.as_bytes()) != selection.content_hash {
        return Err(AppError::new(
            "document_changed",
            "The document changed. Select it again; your draft is preserved.",
        ));
    }
    excerpt(&doc.body, &selection.ranges)
}
fn offset(text: &str, target: u32) -> Option<usize> {
    let mut units = 0;
    for (byte, c) in text.char_indices() {
        if units == target {
            return Some(byte);
        }
        units += c.len_utf16() as u32;
    }
    (units == target).then_some(text.len())
}
pub(crate) fn excerpt(body: &str, ranges: &[DocumentTextRange]) -> AppResult<String> {
    let invalid = || {
        AppError::new(
            "document_selection",
            "Invalid document selection. Select the text again.",
        )
    };
    let mut previous = 0;
    let mut text = String::new();
    for range in ranges {
        let start = offset(body, range.start).ok_or_else(invalid)?;
        let end = offset(body, range.end).ok_or_else(invalid)?;
        if start < previous || end <= start {
            return Err(invalid());
        }
        if !text.is_empty() && body[previous..start].contains('\n') {
            text.push('\n');
        }
        text.push_str(&body[start..end]);
        previous = end;
    }
    Ok(text)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_unicode_ranges_preserve_inline_and_paragraph_selections() {
        let body = "a **😀** [link](url)\n\nnext";
        let ranges = vec![
            DocumentTextRange { start: 4, end: 6 },
            DocumentTextRange { start: 10, end: 14 },
            DocumentTextRange { start: 22, end: 26 },
        ];
        assert_eq!(excerpt(body, &ranges).unwrap(), "😀link\nnext");
        assert!(excerpt(body, &[DocumentTextRange { start: 5, end: 6 }]).is_err());
        assert!(excerpt(body, &[DocumentTextRange { start: 6, end: 4 }]).is_err());
        assert!(
            excerpt(
                body,
                &[
                    DocumentTextRange { start: 0, end: 2 },
                    DocumentTextRange { start: 1, end: 3 }
                ]
            )
            .is_err()
        );
    }
}
