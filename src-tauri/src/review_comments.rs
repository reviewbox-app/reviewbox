//! Human notes about immutable sources. Only the local Markdown file is mutated.
use crate::{
    contracts::*,
    project_storage::{self, Project},
    storage::Storage,
};
use std::{collections::HashSet, fs, io::Read, ops::Range, path::Path};
use tauri::State;

const FILE: &str = ".local/REVIEW_COMMENTS.md";
const MAX_BYTES: usize = 4 * 1024 * 1024;
const START: &str = "<!-- REVIEWBOX_START#";
const END: &str = "<!-- REVIEWBOX_END#";

struct Block {
    span: Range<usize>,
    comment: ReviewComment,
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::new("review_comments", message)
}
fn read_text(path: &Path) -> AppResult<String> {
    match fs::metadata(path) {
        Ok(meta) if !meta.is_file() || meta.len() > MAX_BYTES as u64 => {
            return Err(invalid(
                "The comments document is not a regular file or exceeds 4 MiB.",
            ));
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(e) => return Err(e.into()),
        _ => {}
    }
    let mut text = String::new();
    fs::File::open(path)?
        .take((MAX_BYTES + 1) as u64)
        .read_to_string(&mut text)
        .map_err(|e| invalid(format!("Cannot read comments: {e}")))?;
    if text.len() > MAX_BYTES {
        return Err(invalid("The comments document exceeds 4 MiB."));
    }
    Ok(text)
}
fn parse(text: &str) -> AppResult<Vec<Block>> {
    let mut blocks = Vec::new();
    let mut ids = HashSet::new();
    let mut offset = 0;
    while let Some(start) = text[offset..].find(START).map(|i| i + offset) {
        if start > 0 && !text[..start].ends_with('\n') {
            offset = start + START.len();
            continue;
        }
        let header_end = text[start..]
            .find('\n')
            .map(|i| i + start)
            .ok_or_else(|| invalid("Incomplete comment header; the document was preserved."))?;
        let header = text[start + START.len()..header_end].trim_end_matches('\r');
        let (_, metadata) = header
            .split_once(' ')
            .ok_or_else(|| invalid("Invalid comment header."))?;
        let metadata = metadata
            .strip_suffix(" -->")
            .ok_or_else(|| invalid("Invalid comment metadata."))?;
        let mut comment: ReviewComment = serde_json::from_str(metadata)
            .map_err(|e| invalid(format!("Invalid comment metadata: {e}")))?;
        validate_id(&comment.id)?;
        if !ids.insert(comment.id.clone()) {
            return Err(invalid("Duplicate comment identifier."));
        }
        let terminator = format!("{END}{} -->", comment.id);
        let body_start = header_end + 1;
        let end = text[body_start..]
            .match_indices(&terminator)
            .map(|(i, _)| i + body_start)
            .find(|i| *i == body_start || text[..*i].ends_with('\n'))
            .ok_or_else(|| invalid("Incomplete comment; the document was preserved."))?;
        comment.text = text[body_start..end]
            .trim_end_matches(['\r', '\n'])
            .to_owned();
        let mut after = end + terminator.len();
        if text[after..].starts_with("\r\n") {
            after += 2;
        } else if text[after..].starts_with('\n') {
            after += 1;
        }
        blocks.push(Block {
            span: start..after,
            comment,
        });
        offset = after;
    }
    Ok(blocks)
}
fn encode(comment: &ReviewComment) -> AppResult<String> {
    let mut metadata = serde_json::to_value(comment)?;
    metadata.as_object_mut().unwrap().remove("text");
    let location = match &comment.anchor {
        ReviewCommentAnchor::Code(a) => format!(
            "{}:{}<->{}:{}",
            a.range.start_line, a.range.start_column, a.range.end_line, a.range.end_column
        ),
        ReviewCommentAnchor::Document(a) => format!("document:{}", a.document.step_id),
    };
    Ok(format!(
        "{START}{location} {} -->\n{}\n{END}{} -->\n",
        serde_json::to_string(&metadata)?
            .replace('<', "\\u003c")
            .replace('>', "\\u003e"),
        comment.text.trim_end_matches(['\r', '\n']),
        comment.id
    ))
}
fn validate_id(id: &str) -> AppResult<()> {
    if id.is_empty() || id.len() > 80 || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
    {
        return Err(invalid("Invalid comment identifier."));
    }
    Ok(())
}
fn validate_text(text: &str) -> AppResult<()> {
    if text.trim().is_empty()
        || text.len() > 32_768
        || text.contains('\0')
        || text.contains(START)
        || text.contains(END)
    {
        return Err(invalid(
            "Write a comment of at most 32 KiB without reserved ReviewBox markers.",
        ));
    }
    Ok(())
}
fn byte_column(line: &str, column: u32) -> Option<usize> {
    let target = column.checked_sub(1)? as usize;
    let mut units = 0;
    for (byte, character) in line.char_indices() {
        if units == target {
            return Some(byte);
        }
        units += character.len_utf16();
    }
    (units == target).then_some(line.len())
}
fn selected_text(text: &str, range: &ReviewCommentRange) -> AppResult<String> {
    let text = text
        .strip_prefix('\u{feff}')
        .unwrap_or(text)
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let lines: Vec<_> = text.split('\n').collect();
    let start = range
        .start_line
        .checked_sub(1)
        .and_then(|i| lines.get(i as usize));
    let end = range
        .end_line
        .checked_sub(1)
        .and_then(|i| lines.get(i as usize));
    if (range.end_line, range.end_column) <= (range.start_line, range.start_column) {
        return Err(invalid("Select a nonempty source range."));
    }
    let from = start
        .and_then(|line| byte_column(line, range.start_column))
        .ok_or_else(|| invalid("Invalid start column."))?;
    let to = end
        .and_then(|line| byte_column(line, range.end_column))
        .ok_or_else(|| invalid("Invalid end column."))?;
    let first = range.start_line as usize - 1;
    let last = range.end_line as usize - 1;
    let excerpt = if first == last {
        lines[first][from..to].to_owned()
    } else {
        let mut parts = vec![&lines[first][from..]];
        parts.extend_from_slice(&lines[first + 1..last]);
        parts.push(&lines[last][..to]);
        parts.join("\n")
    };
    if excerpt.len() > 64 * 1024 {
        return Err(invalid("Select at most 64 KiB of source."));
    }
    Ok(excerpt)
}
fn update_text(text: &str, review_id: &str, mutation: ReviewCommentMutation) -> AppResult<String> {
    let blocks = parse(text)?;
    let mut next = text.to_owned();
    match mutation {
        ReviewCommentMutation::Add {
            id,
            anchor,
            text: body,
        } => {
            validate_id(&id)?;
            validate_text(&body)?;
            let body = body.trim_end_matches(['\r', '\n']).to_owned();
            if let Some(existing) = blocks.iter().find(|b| b.comment.id == id) {
                if existing.comment.review_id == review_id
                    && existing.comment.anchor == anchor
                    && existing.comment.text == body
                {
                    return Ok(next);
                }
                return Err(invalid(
                    "This comment identifier already belongs to another comment.",
                ));
            }
            if next.is_empty() {
                next.push_str("# ReviewBox review comments\n\nLocal human notes about captured sources. Coordinates use one-based lines and UTF-16 columns; the end is exclusive. Keep resolution and test evidence when marking a comment addressed.\n");
            }
            if !next.ends_with('\n') {
                next.push('\n');
            }
            next.push('\n');
            let timestamp = now();
            next.push_str(&encode(&ReviewComment {
                id,
                review_id: review_id.into(),
                anchor,
                text: body,
                status: ReviewCommentStatus::Open,
                resolution: String::new(),
                tests: String::new(),
                created_at: timestamp.clone(),
                updated_at: timestamp,
            })?);
        }
        ReviewCommentMutation::Edit {
            id,
            text: body,
            status,
            resolution,
            tests,
        } => {
            validate_text(&body)?;
            let body = body.trim_end_matches(['\r', '\n']).to_owned();
            if resolution.len() > 32_768 || tests.len() > 32_768 {
                return Err(invalid("Resolution or test evidence exceeds 32 KiB."));
            }
            let block = blocks
                .iter()
                .find(|b| b.comment.id == id && b.comment.review_id == review_id)
                .ok_or_else(|| invalid("This comment no longer exists in the selected review."))?;
            let mut comment = block.comment.clone();
            if comment.text == body
                && comment.status == status
                && comment.resolution == resolution
                && comment.tests == tests
            {
                return Ok(next);
            }
            comment.text = body;
            comment.status = status;
            comment.resolution = resolution;
            comment.tests = tests;
            comment.updated_at = now();
            next.replace_range(block.span.clone(), &encode(&comment)?);
        }
        ReviewCommentMutation::Delete { id } => {
            if let Some(block) = blocks
                .iter()
                .find(|b| b.comment.id == id && b.comment.review_id == review_id)
            {
                next.replace_range(block.span.clone(), "");
            }
        }
    }
    if next.len() > MAX_BYTES {
        return Err(invalid("The comments document exceeds 4 MiB."));
    }
    Ok(next)
}
fn document(
    project: &Project,
    review_id: &str,
    prompt_root: &Path,
) -> AppResult<ReviewCommentsDocument> {
    let text = read_text(&project_storage::checked(&project.root, FILE)?)?;
    let comments = parse(&text)?
        .into_iter()
        .map(|b| b.comment)
        .filter(|c| c.review_id == review_id)
        .collect();
    let shared_file_present =
        project_storage::checked(&project.root, "REVIEW_COMMENTS.md")?.is_file();
    let template = fs::read_to_string(prompt_root.join("prompts/review-corrections.md"))?;
    let correction_prompt = template.replace("{{review_id}}", review_id);
    Ok(ReviewCommentsDocument {
        revision: fingerprint(text.as_bytes()),
        comments,
        shared_file_present,
        correction_prompt,
        outdated_comment_ids: Vec::new(),
    })
}
fn load(
    storage: &Storage,
    repository_id: &str,
    review_id: &str,
) -> AppResult<(Project, Workspace)> {
    let scoped = storage.scoped(Some(repository_id));
    let workspace = crate::reviews::load(&scoped, review_id)?;
    if workspace.review.repository_id != repository_id {
        return Err(invalid("This review belongs to another checkout."));
    }
    let root = crate::repositories::root(&scoped, repository_id)?;
    Ok((Project::open(&root, repository_id)?, workspace))
}
#[tauri::command]
pub async fn read_review_comments(
    app: tauri::AppHandle,
    storage: State<'_, Storage>,
    repository_id: String,
    review_id: Option<String>,
) -> AppResult<ReviewCommentsDocument> {
    let storage = storage.inner().clone();
    let prompt_root = crate::commands::resource_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(review_id) = review_id {
            let (project, workspace) = load(&storage, &repository_id, &review_id)?;
            let _lock = project.lock()?;
            let mut result = document(&project, &review_id, &prompt_root)?;
            for comment in &result.comments {
                if let ReviewCommentAnchor::Document(anchor) = &comment.anchor
                    && crate::review_documents::verify(&workspace, &anchor.document).is_err()
                {
                    result.outdated_comment_ids.push(comment.id.clone());
                }
            }
            Ok(result)
        } else {
            local_document(&storage, &repository_id, &prompt_root)
        }
    })
    .await
    .map_err(|e| invalid(e.to_string()))?
}
#[tauri::command]
pub async fn mutate_review_comment(
    app: tauri::AppHandle,
    storage: State<'_, Storage>,
    repository_id: String,
    review_id: Option<String>,
    expected_revision: String,
    mut mutation: ReviewCommentMutation,
) -> AppResult<ReviewCommentsDocument> {
    let storage = storage.inner().clone();
    let prompt_root = crate::commands::resource_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(review_id) = review_id else {
            return mutate_local(
                &storage,
                &repository_id,
                &prompt_root,
                &expected_revision,
                mutation,
            );
        };
        let (project, workspace) = load(&storage, &repository_id, &review_id)?;
        crate::reviews::require_draft(&workspace.review)?;
        if let ReviewCommentMutation::Add { anchor, .. } = &mut mutation {
            match anchor {
                ReviewCommentAnchor::Document(anchor) => {
                    anchor.title = Some(
                        crate::review_documents::step(&workspace.review, &anchor.document.step_id)?
                            .title
                            .clone(),
                    );
                    anchor.excerpt = crate::review_documents::verify(&workspace, &anchor.document)?;
                    if anchor.excerpt.trim().is_empty() {
                        return Err(invalid("Select document text before commenting."));
                    }
                }
                ReviewCommentAnchor::Code(anchor) => {
                    if anchor.local.is_some() || anchor.snapshot_id != workspace.snapshot.id {
                        return Err(invalid("The capture changed. Select the source again."));
                    }
                    let source = crate::reader::source(
                        &storage.scoped(Some(&repository_id)),
                        &workspace.snapshot,
                        &anchor.source_id,
                    )?;
                    if source.hash != anchor.content_hash || source.path != anchor.path {
                        return Err(invalid("The comment does not match the captured source."));
                    }
                    let text = source
                        .text
                        .ok_or_else(|| invalid("This source cannot be commented."))?;
                    anchor.excerpt = selected_text(&text, &anchor.range)?;
                }
            }
        }
        let _lock = project.lock()?;
        // A completion/refresh may have happened while source validation ran.
        let documents = project.read()?;
        let current = documents
            .get(&("review".into(), review_id.clone()))
            .ok_or_else(|| invalid("This review no longer exists."))?;
        if current["publication"]["status"] != "draft" {
            return Err(invalid("Only a draft accepts comment changes."));
        }
        if current["snapshotId"] != workspace.snapshot.id {
            return Err(invalid(
                "The capture changed. Reload the review before saving.",
            ));
        }
        if let ReviewCommentMutation::Add {
            anchor: ReviewCommentAnchor::Document(anchor),
            ..
        } = &mutation
        {
            let mut hydrated = current.clone();
            project_storage::step_documents::hydrate(
                &project.document_root("review", &review_id),
                &mut hydrated,
            )?;
            let review: Review = serde_json::from_value(hydrated)?;
            crate::review_documents::verify_review(&review, &anchor.document)?;
        }
        let path = project_storage::checked(&project.root, FILE)?;
        let before = read_text(&path)?;
        let next = update_text(&before, &review_id, mutation)?;
        // Idempotent retries succeed even if the first write changed the hash.
        if next != before {
            if fingerprint(before.as_bytes()) != expected_revision || read_text(&path)? != before {
                return Err(AppError::new(
                    "comments_conflict",
                    "Comments changed on disk. Reload before saving; your text is preserved.",
                ));
            }
            project_storage::atomic(&path, next.as_bytes())?;
        }
        document(&project, &review_id, &prompt_root)
    })
    .await
    .map_err(|e| invalid(e.to_string()))?
}

mod local;
use local::{local_document, mutate_local};

#[cfg(test)]
mod tests;
