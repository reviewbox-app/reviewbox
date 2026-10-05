use super::git;
use crate::contracts::*;
use std::{path::Path, sync::atomic::AtomicBool};

pub(super) fn list(root: &Path) -> AppResult<Vec<String>> {
    Ok(git::text(
        root,
        &[
            "for-each-ref",
            "--sort=refname",
            "--format=%(refname:strip=2)",
            "refs/heads/",
        ],
    )?
    .lines()
    .map(str::to_owned)
    .collect())
}

pub(super) fn switch(root: &Path, branch: &str, cancel: &AtomicBool) -> AppResult<()> {
    // Only exact local refs from the picker are accepted: no revision expressions,
    // option injection, implicit remote tracking or detached checkouts.
    if !list(root)?.iter().any(|name| name == branch) {
        return Err(AppError::new(
            "branch_missing",
            "This local branch no longer exists. Refresh the branch list.",
        ));
    }
    git::run(
        root,
        &["switch", "--no-guess", "--", branch],
        None,
        &[],
        cancel,
    )?;
    Ok(())
}
