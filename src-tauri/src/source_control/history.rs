use super::{SourceControl, git, working};
use crate::contracts::*;
use std::{
    path::Path,
    sync::atomic::AtomicBool,
    time::{Duration, Instant},
};

fn branch(root: &Path) -> Option<String> {
    git::text(root, &["symbolic-ref", "--quiet", "--short", "HEAD"]).ok()
}
fn config(root: &Path, key: &str) -> Option<String> {
    git::text(root, &["config", "--get", key])
        .ok()
        .filter(|s| !s.is_empty())
}
fn counts(root: &Path, reference: &str) -> AppResult<(u32, u32)> {
    let value = git::text(
        root,
        &[
            "rev-list",
            "--left-right",
            "--count",
            &format!("{reference}...HEAD"),
        ],
    )?;
    let mut parts = value.split_whitespace().map(str::parse::<u32>);
    let behind = parts.next().and_then(Result::ok).unwrap_or(0);
    let ahead = parts.next().and_then(Result::ok).unwrap_or(0);
    Ok((ahead, behind))
}
pub(super) fn summaries(
    root: &Path,
    refs: &[&str],
    limit: Option<u32>,
) -> AppResult<Vec<GitCommitSummary>> {
    let format = "--format=%H%x00%an%x00%aI%x00%s";
    let max = limit.map(|n| format!("--max-count={n}"));
    let mut args = vec!["log", "-z", format];
    if let Some(max) = &max {
        args.push(max);
    }
    args.extend(refs);
    let bytes = git::read(root, &args)?;
    let fields: Vec<_> = bytes.split(|b| *b == 0).collect();
    Ok(fields
        .chunks_exact(4)
        .map(|p| GitCommitSummary {
            oid: String::from_utf8_lossy(p[0]).into(),
            author: String::from_utf8_lossy(p[1]).into(),
            date: String::from_utf8_lossy(p[2]).into(),
            subject: String::from_utf8_lossy(p[3]).into(),
        })
        .collect())
}
pub(super) fn commit(root: &Path, oid: &str) -> AppResult<GitCommitSummary> {
    if oid.len() < 40 || !oid.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::new("commit", "Invalid commit ID."));
    }
    summaries(root, &[oid], Some(1))?
        .into_iter()
        .next()
        .ok_or_else(|| AppError::new("commit", "Commit not found."))
}
pub(super) fn detail(root: &Path, oid: &str) -> AppResult<GitCommitDetail> {
    let commit = commit(root, oid)?;
    let message = git::text(root, &["show", "-s", "--format=%B", oid])?;
    let bytes = git::read(
        root,
        &[
            "diff-tree",
            "--root",
            "--first-parent",
            "-m",
            "--no-commit-id",
            "--numstat",
            "-r",
            "-M",
            "-z",
            oid,
        ],
    )?;
    let mut entries = bytes.split(|b| *b == 0).filter(|s| !s.is_empty());
    let mut files = Vec::new();
    while let Some(entry) = entries.next() {
        let value = String::from_utf8_lossy(entry);
        let parts: Vec<_> = value.splitn(3, '\t').collect();
        if parts.len() != 3 {
            continue;
        }
        let (path, previous_path) = if parts[2].is_empty() {
            let old = String::from_utf8_lossy(
                entries
                    .next()
                    .ok_or_else(|| AppError::new("git", "Missing rename source."))?,
            )
            .into_owned();
            let path = String::from_utf8_lossy(
                entries
                    .next()
                    .ok_or_else(|| AppError::new("git", "Missing rename destination."))?,
            )
            .into_owned();
            (path, Some(old))
        } else {
            (parts[2].into(), None)
        };
        if !files.iter().any(|f: &GitCommitFile| f.path == path) {
            files.push(GitCommitFile {
                path,
                previous_path,
                additions: parts[0].parse().ok(),
                deletions: parts[1].parse().ok(),
            });
        }
    }
    Ok(GitCommitDetail {
        commit,
        message,
        files,
    })
}
pub(super) fn in_progress(root: &Path) -> AppResult<Option<String>> {
    for (file, label) in [
        ("MERGE_HEAD", "merge"),
        ("rebase-merge", "rebase"),
        ("rebase-apply", "rebase"),
        ("CHERRY_PICK_HEAD", "cherry-pick"),
        ("REVERT_HEAD", "revert"),
        ("sequencer", "sequenced operation"),
    ] {
        if git::git_path(root, file)?.exists() {
            return Ok(Some(format!(
                "Finish the {label} in another tool before committing or pushing from ReviewBox."
            )));
        }
    }
    if !git::read(root, &["ls-files", "--unmerged", "-z"])?.is_empty() {
        return Ok(Some(
            "Resolve Git conflicts in another tool before continuing.".into(),
        ));
    }
    Ok(None)
}
pub(super) fn state(
    manager: &SourceControl,
    root: &Path,
    repository_id: &str,
) -> AppResult<LocalGitState> {
    let branch = branch(root);
    let head = git::head(root);
    let upstream = git::text(
        root,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    )
    .ok();
    let remotes = git::text(root, &["remote"])?
        .lines()
        .map(String::from)
        .collect();
    let (ahead, behind, local_commits, remote_commits) = if head.is_some() {
        if let Some(upstream) = &upstream {
            let (ahead, behind) = counts(root, upstream)?;
            (
                ahead,
                behind,
                summaries(root, &[&format!("{upstream}..HEAD")], None)?,
                summaries(root, &[upstream], Some(5))?,
            )
        } else {
            let local = summaries(root, &["HEAD", "--not", "--remotes"], None)?;
            (local.len() as u32, 0, local, vec![])
        }
    } else {
        (0, 0, vec![], vec![])
    };
    let blocked_reason=in_progress(root)?.or_else(||{
        if branch.is_none(){Some("Check out a branch in another tool before committing or pushing.".into())}
        else if behind>0 {Some("The remote has commits to pull. Synchronize and resolve any conflicts in another tool; ReviewBox cannot pull or merge yet.".into())}
        else {None}
    });
    Ok(LocalGitState {
        repository_id: repository_id.into(),
        branch,
        head,
        upstream,
        remotes,
        files: working::files(root)?,
        index_version: working::index_version(root)?,
        ahead,
        behind,
        local_commits,
        remote_commits,
        blocked_reason,
        remote_check: manager.remote_check(root),
    })
}
pub(super) fn fetch(
    manager: &SourceControl,
    root: &Path,
    force: bool,
    cancel: &AtomicBool,
) -> AppResult<()> {
    let key = root.to_string_lossy().into_owned();
    if !force
        && manager
            .checked
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&key)
            .is_some_and(|(at, _)| at.elapsed() < Duration::from_secs(60))
    {
        return Ok(());
    }
    let remotes = git::text(root, &["remote"])?;
    let result = (|| {
        for remote in remotes.lines() {
            git::run(
                root,
                &["fetch", "--no-tags", "--", remote],
                None,
                &[],
                cancel,
            )?;
        }
        Ok::<_, AppError>(())
    })();
    let previous = manager.remote_check(root);
    manager
        .checked
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(
            key,
            (
                Instant::now(),
                GitRemoteCheck {
                    checked_at: if result.is_ok() {
                        Some(now())
                    } else {
                        previous.checked_at
                    },
                    error: result.as_ref().err().map(|e| e.message.clone()),
                },
            ),
        );
    result
}
pub(super) fn push(
    manager: &SourceControl,
    root: &Path,
    expected_branch: &str,
    chosen_remote: Option<&str>,
    cancel: &AtomicBool,
) -> AppResult<()> {
    if branch(root).as_deref() != Some(expected_branch) {
        return Err(AppError::new(
            "git_changed",
            "The checked-out branch changed.",
        ));
    }
    fetch(manager, root, true, cancel)?;
    if let Some(reason) = in_progress(root)? {
        return Err(AppError::new("git_conflict", reason));
    }
    if branch(root).as_deref() != Some(expected_branch) {
        return Err(AppError::new(
            "git_changed",
            "The branch changed during the remote check.",
        ));
    }
    let remote = config(root, &format!("branch.{expected_branch}.remote"));
    let merge = config(root, &format!("branch.{expected_branch}.merge"));
    let has_upstream = remote.is_some() && merge.is_some();
    let remotes = git::text(root, &["remote"])?;
    let remote = remote
        .as_deref()
        .or(chosen_remote)
        .or_else(|| {
            let mut r = remotes.lines();
            let one = r.next();
            if r.next().is_none() { one } else { None }
        })
        .ok_or_else(|| {
            AppError::new("remote_required", "Choose a remote to publish this branch.")
        })?;
    if !remotes.lines().any(|r| r == remote) {
        return Err(AppError::new(
            "remote_required",
            "Configure a remote in another tool first.",
        ));
    }
    let target = merge.unwrap_or_else(|| format!("refs/heads/{expected_branch}"));
    if !target.starts_with("refs/heads/") {
        return Err(AppError::new(
            "remote_required",
            "The upstream is not a branch.",
        ));
    }
    let remote_ref = format!(
        "refs/remotes/{remote}/{}",
        target.trim_start_matches("refs/heads/")
    );
    if git::text(root, &["rev-parse", "--verify", &remote_ref]).is_ok()
        && counts(root, &remote_ref)?.1 > 0
    {
        return Err(AppError::new(
            "git_behind",
            "Synchronize this branch in another tool before pushing.",
        ));
    }
    let refspec = format!("refs/heads/{expected_branch}:{target}");
    let mut args = vec![
        "-c",
        "push.followTags=false",
        "push",
        "--porcelain",
        "--no-follow-tags",
    ];
    if !has_upstream {
        args.push("--set-upstream");
    }
    args.extend(["--", remote, &refspec]);
    git::run(root, &args, None, &[], cancel)?;
    Ok(())
}
