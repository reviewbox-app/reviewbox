//! Local comments are checkout-scoped notes, not synthetic reviews or decisions.
use super::*;

fn scope(repository_id: &str) -> String {
    format!("local:{repository_id}")
}

fn source(root: &Path, anchor: &ReviewCommentAnchor, check_version: bool) -> AppResult<String> {
    let ReviewCommentAnchor::Code(anchor) = anchor else {
        return Err(invalid("Document comments belong to a review."));
    };
    let local = anchor
        .local
        .as_ref()
        .ok_or_else(|| invalid("Missing local source identity."))?;
    if !anchor.snapshot_id.is_empty() || !anchor.source_id.is_empty() {
        return Err(invalid("Local comments cannot refer to a review capture."));
    }
    // Reuse the native path boundary even for historical sides of renamed files.
    crate::editor::path(root, &local.path)?;
    let (text, hash, path) = match local.layer.as_str() {
        "file" if local.side == "after" => {
            let file = crate::editor::read(root, &local.path)?;
            if check_version && file.revision != local.version {
                return Err(invalid(
                    "The source changed. Select the source again; your comment draft is preserved.",
                ));
            }
            (file.text, file.revision, file.path)
        }
        "staged" | "unstaged" if matches!(local.side.as_str(), "before" | "after") => {
            let diff = crate::source_control::comment_diff(
                root,
                &local.path,
                &local.layer,
                check_version.then_some(local.version.as_str()),
            )?;
            if diff.change.binary || diff.content.unavailable_reason.is_some() {
                return Err(invalid("This source cannot be commented."));
            }
            let (blob, text, path) = if local.side == "before" {
                (
                    diff.change.before,
                    diff.content.before,
                    diff.change.previous_path.unwrap_or(diff.change.path),
                )
            } else {
                (diff.change.after, diff.content.after, diff.change.path)
            };
            (
                text.ok_or_else(|| invalid("This source no longer exists."))?,
                blob.ok_or_else(|| invalid("Missing source version."))?.hash,
                path,
            )
        }
        _ => return Err(invalid("Invalid local source layer or side.")),
    };
    if path != anchor.path || hash != anchor.content_hash {
        return Err(invalid(
            "The source changed. Select the source again; your comment draft is preserved.",
        ));
    }
    Ok(text)
}

pub(super) fn local_document(
    storage: &Storage,
    repository_id: &str,
    prompt_root: &Path,
) -> AppResult<ReviewCommentsDocument> {
    let root = crate::repositories::root(storage, repository_id)?;
    let project = Project::open(&root, repository_id)?;
    let mut result = {
        let _lock = project.lock()?;
        document(&project, &scope(repository_id), prompt_root)?
    };
    result.correction_prompt =
        fs::read_to_string(prompt_root.join("prompts/local-code-corrections.md"))?
            .replace("{{context_id}}", &scope(repository_id));
    for comment in &result.comments {
        if source(&root, &comment.anchor, false).is_err() {
            result.outdated_comment_ids.push(comment.id.clone());
        }
    }
    Ok(result)
}

pub(super) fn mutate_local(
    storage: &Storage,
    repository_id: &str,
    prompt_root: &Path,
    expected_revision: &str,
    mut mutation: ReviewCommentMutation,
) -> AppResult<ReviewCommentsDocument> {
    let root = crate::repositories::root(storage, repository_id)?;
    let project = Project::open(&root, repository_id)?;
    {
        let _lock = project.lock()?;
        if let ReviewCommentMutation::Add { anchor, .. } = &mut mutation {
            let text = source(&root, anchor, true)?;
            if let ReviewCommentAnchor::Code(anchor) = anchor {
                anchor.excerpt = selected_text(&text, &anchor.range)?;
            }
        }
        let path = project_storage::checked(&project.root, FILE)?;
        let before = read_text(&path)?;
        let next = update_text(&before, &scope(repository_id), mutation)?;
        if next != before {
            if fingerprint(before.as_bytes()) != expected_revision || read_text(&path)? != before {
                return Err(AppError::new(
                    "comments_conflict",
                    "Comments changed on disk. Reload before saving; your text is preserved.",
                ));
            }
            project_storage::atomic(&path, next.as_bytes())?;
        }
    }
    local_document(storage, repository_id, prompt_root)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn git(root: &Path, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(root)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }
    fn file_anchor(root: &Path, path: &str) -> ReviewCommentAnchor {
        let file = crate::editor::read(root, path).unwrap();
        CodeCommentAnchor {
            local: Some(LocalCommentSource {
                path: path.into(),
                layer: "file".into(),
                side: "after".into(),
                version: file.revision.clone(),
            }),
            snapshot_id: String::new(),
            source_id: String::new(),
            path: path.into(),
            content_hash: file.revision,
            range: ReviewCommentRange {
                start_line: 1,
                start_column: 1,
                end_line: 1,
                end_column: 3,
            },
            excerpt: "untrusted".into(),
        }
        .into()
    }
    #[test]
    fn local_comments_verify_sources_preserve_history_and_never_create_reviews() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        fs::create_dir(&root).unwrap();
        git(&root, &["init", "-q"]);
        let storage = Storage::open(temp.path().join("private")).unwrap();
        let repo = crate::repositories::open(&storage, root.to_str().unwrap()).unwrap();
        fs::write(root.join("a.ts"), "hi😀\r\n").unwrap();
        let prompts = Path::new(env!("CARGO_MANIFEST_DIR")).join("../resources/agents");
        let initial = local_document(&storage, &repo.id, &prompts).unwrap();
        let anchor = file_anchor(&root, "a.ts");
        let saved = mutate_local(
            &storage,
            &repo.id,
            &prompts,
            &initial.revision,
            ReviewCommentMutation::Add {
                id: "local-note".into(),
                anchor: anchor.clone(),
                text: "Check this".into(),
            },
        )
        .unwrap();
        assert_eq!(saved.comments[0].anchor.excerpt(), "hi");
        assert!(saved.outdated_comment_ids.is_empty());
        assert_eq!(saved.comments[0].review_id, scope(&repo.id));
        fs::write(root.join("a.ts"), "changed").unwrap();
        assert!(
            mutate_local(
                &storage,
                &repo.id,
                &prompts,
                &saved.revision,
                ReviewCommentMutation::Add {
                    id: "old-note".into(),
                    anchor,
                    text: "Stale".into()
                }
            )
            .is_err()
        );
        let stale = local_document(&storage, &repo.id, &prompts).unwrap();
        assert_eq!(stale.outdated_comment_ids, vec!["local-note"]);
        assert_eq!(stale.comments[0].anchor.excerpt(), "hi");
        let project = Project::open(&root, &repo.id).unwrap();
        assert!(
            !project
                .read()
                .unwrap()
                .keys()
                .any(|(kind, _)| kind == "review")
        );
        assert!(
            mutate_local(
                &storage,
                &repo.id,
                &prompts,
                "bad-revision",
                ReviewCommentMutation::Delete {
                    id: "local-note".into()
                }
            )
            .is_err()
        );
        let mut traversal = file_anchor(&root, "a.ts");
        if let ReviewCommentAnchor::Code(a) = &mut traversal {
            a.local.as_mut().unwrap().path = "../outside".into();
        }
        assert!(source(&root, &traversal, true).is_err());
        assert_eq!(fs::read_to_string(root.join("a.ts")).unwrap(), "changed");
    }
    #[test]
    fn local_diff_anchors_distinguish_layers_deleted_and_renamed_sides() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        git(root, &["init", "-q"]);
        git(root, &["config", "user.name", "Test"]);
        git(root, &["config", "user.email", "test@example.invalid"]);
        fs::write(root.join("a.ts"), "before\n").unwrap();
        git(root, &["add", "."]);
        git(
            root,
            &["-c", "commit.gpgsign=false", "commit", "-qm", "initial"],
        );
        git(root, &["mv", "a.ts", "renamed.ts"]);
        let make = |layer: &str, side: &str| -> ReviewCommentAnchor {
            let diff =
                crate::source_control::comment_diff(root, "renamed.ts", layer, None).unwrap();
            let blob = if side == "before" {
                diff.change.before
            } else {
                diff.change.after
            }
            .unwrap();
            CodeCommentAnchor {
                local: Some(LocalCommentSource {
                    path: "renamed.ts".into(),
                    layer: layer.into(),
                    side: side.into(),
                    version: diff.version,
                }),
                snapshot_id: String::new(),
                source_id: String::new(),
                path: if side == "before" {
                    diff.change.previous_path.unwrap_or(diff.change.path)
                } else {
                    diff.change.path
                },
                content_hash: blob.hash,
                range: ReviewCommentRange {
                    start_line: 1,
                    start_column: 1,
                    end_line: 1,
                    end_column: 3,
                },
                excerpt: String::new(),
            }
            .into()
        };
        let before = make("staged", "before");
        assert!(matches!(&before, ReviewCommentAnchor::Code(a) if a.path == "a.ts"));
        assert_eq!(source(root, &before, true).unwrap(), "before\n");
        fs::write(root.join("renamed.ts"), "working\n").unwrap();
        let unstaged = make("unstaged", "after");
        assert_eq!(source(root, &unstaged, true).unwrap(), "working\n");
        let index = git(root, &["write-tree"]);
        fs::remove_file(root.join("renamed.ts")).unwrap();
        let deleted = make("unstaged", "before");
        assert_eq!(source(root, &deleted, true).unwrap(), "before\n");
        assert!(source(root, &unstaged, true).is_err());
        assert_eq!(git(root, &["write-tree"]), index);
    }
}
