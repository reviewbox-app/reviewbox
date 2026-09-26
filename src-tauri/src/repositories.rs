use crate::{contracts::*, storage::Storage};
use std::{
    path::{Path, PathBuf},
    process::{Command, Output},
};

pub fn git(root: &Path, args: &[&str]) -> AppResult<Vec<u8>> {
    let Output {
        status,
        stdout,
        stderr,
    } = Command::new("git")
        .arg("--no-optional-locks")
        .arg("-c")
        .arg("core.fsmonitor=false")
        .arg("-c")
        .arg("core.hooksPath=/dev/null")
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()?;
    if !status.success() {
        return Err(AppError::new(
            "git",
            String::from_utf8_lossy(&stderr).trim().to_string(),
        ));
    }
    Ok(stdout)
}
pub fn text(root: &Path, args: &[&str]) -> AppResult<String> {
    String::from_utf8(git(root, args)?)
        .map(|s| s.trim_end_matches('\n').to_string())
        .map_err(|_| AppError::new("unsupported_path", "Git returned a non-UTF-8 path."))
}
pub fn open(storage: &Storage, path: &str) -> AppResult<Repository> {
    let candidate = PathBuf::from(path).canonicalize()?;
    let root =
        PathBuf::from(text(&candidate, &["rev-parse", "--show-toplevel"])?).canonicalize()?;
    let path = root
        .to_str()
        .ok_or_else(|| {
            AppError::new(
                "unsupported_path",
                "Non-UTF-8 repository paths are not supported.",
            )
        })?
        .to_string();
    let mut repository = Repository {
        id: fingerprint(path.as_bytes()),
        name: root
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into(),
        path,
        branch: text(&root, &["symbolic-ref", "--short", "HEAD"])
            .unwrap_or_else(|_| "Detached HEAD".into()),
        opened_at: now(),
    };
    if let Ok(existing) = storage.get::<Repository>("repository", &repository.id) {
        repository.opened_at = existing.opened_at;
    } else {
        storage.insert("repository", &repository.id, &repository)?;
    }
    storage.scoped(Some(&repository.id)).mount(&repository)?;
    Ok(repository)
}
pub fn root(storage: &Storage, repository_id: &str) -> AppResult<PathBuf> {
    let repo: Repository = storage.get("repository", repository_id)?;
    let root = PathBuf::from(&repo.path).canonicalize()?;
    if text(&root, &["rev-parse", "--show-toplevel"])? != repo.path {
        return Err(AppError::new(
            "repository_changed",
            "Repository location no longer matches.",
        ));
    }
    Ok(root)
}
pub fn resolve(root: &Path, reference: &str) -> AppResult<String> {
    text(
        root,
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{reference}^{{commit}}"),
        ],
    )
}
