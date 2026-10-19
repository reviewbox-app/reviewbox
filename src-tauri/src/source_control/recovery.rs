//! Explicit recovery actions preserve Git history, index data and operation receipts.
use super::{SourceControl, commits, git, review_commit::ReviewCommits};
use crate::{contracts::*, repositories, storage::Storage};
use std::{fs, path::Path, process::Command, time::Duration};
use tauri::State;

fn busy(message: &str) -> AppError {
    AppError::new("index_locked", message)
}

/// Unknown locks require an explicit action, inactivity checks and a retained copy.
fn release(root: &Path) -> AppResult<()> {
    let path = git::git_path(root, "index.lock")?;
    let metadata = match fs::symlink_metadata(&path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_file()
        || metadata.modified()?.elapsed().unwrap_or_default() < Duration::from_secs(5)
    {
        return Err(busy(
            "The lock is new or is not a regular file. Wait for the Git operation to finish, then try again.",
        ));
    }
    let bytes = fs::read(&path)?;
    if let Ok(text) = std::str::from_utf8(&bytes)
        && let Some(pid) = text
            .strip_prefix("ReviewBox index lock v1 ")
            .and_then(|s| s.split_whitespace().next())
            .and_then(|s| s.parse::<u32>().ok())
    {
        let probe = Command::new("kill")
            .args(["-0", &pid.to_string()])
            .env("LC_ALL", "C")
            .output()?;
        if pid == 0
            || probe.status.success()
            || !String::from_utf8_lossy(&probe.stderr)
                .to_lowercase()
                .contains("no such process")
        {
            return Err(busy(
                "ReviewBox still owns this lock. Stop the running operation before recovering it.",
            ));
        }
    }
    #[cfg(unix)]
    {
        // Git may close its lock descriptor while keeping the reservation.
        // Check both process names and open descriptors; fail closed on probe errors.
        let processes = Command::new("ps").args(["-axo", "comm="]).output()?;
        if !processes.status.success() {
            return Err(busy("Could not verify running Git processes."));
        }
        if String::from_utf8_lossy(&processes.stdout).lines().any(|p| {
            let name = Path::new(p.trim())
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("");
            name == "git" || name.starts_with("git-")
        }) {
            return Err(busy(
                "A Git process is still running. Let it finish or stop it in its application, then retry.",
            ));
        }
        let handles = Command::new(if cfg!(target_os = "macos") {
            "/usr/sbin/lsof"
        } else {
            "lsof"
        })
        .args(["-t", "--"])
        .arg(&path)
        .output()?;
        if handles.status.code() != Some(1)
            || !handles.stdout.is_empty()
            || !handles.stderr.is_empty()
        {
            return Err(busy(
                "The lock is still open, or its owner could not be checked. Close the Git operation and retry.",
            ));
        }
        preserve_and_remove(&path, &metadata, &bytes)
    }
    #[cfg(not(unix))]
    Err(busy(
        "Automatic lock recovery is unavailable on this platform. Close Git tools and inspect index.lock manually.",
    ))
}

#[cfg(unix)]
fn preserve_and_remove(path: &Path, metadata: &fs::Metadata, bytes: &[u8]) -> AppResult<()> {
    use std::os::unix::fs::MetadataExt;
    let current = fs::symlink_metadata(path)?;
    if current.dev() != metadata.dev()
        || current.ino() != metadata.ino()
        || fs::read(path)? != bytes
        || current.modified()? != metadata.modified()?
    {
        return Err(busy(
            "The lock changed during recovery. Retry after the active operation finishes.",
        ));
    }
    let directory = path.parent().unwrap().join("reviewbox-lock-backups");
    fs::create_dir_all(&directory)?;
    let backup = directory.join(format!("index-{}.lock", id()));
    fs::hard_link(path, &backup)?;
    let current = fs::symlink_metadata(path)?;
    if current.ino() != metadata.ino() || fs::read(path)? != bytes {
        return Err(busy(
            "The lock changed during recovery; it was left in place.",
        ));
    }
    fs::remove_file(path)?;
    Ok(())
}

#[tauri::command]
pub async fn recover_git_lock(
    storage: State<'_, Storage>,
    manager: State<'_, SourceControl>,
    repository_id: String,
) -> AppResult<()> {
    let storage = storage.inner().clone();
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = repositories::root(&storage, &repository_id)?;
        let _guard = manager.begin(&root, &id())?;
        release(&root)
    })
    .await
    .map_err(|e| AppError::new("task", e.to_string()))?
}

#[tauri::command]
pub async fn clear_git_plans(
    app: tauri::AppHandle,
    storage: State<'_, Storage>,
    manager: State<'_, SourceControl>,
    jobs: State<'_, ReviewCommits>,
    repository_id: String,
) -> AppResult<()> {
    let storage = storage.inner().clone();
    let manager = manager.inner().clone();
    let jobs = jobs.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = repositories::root(&storage, &repository_id)?;
        let _guard = manager.begin(&root, &id())?;
        commits::dismiss(&storage, &repository_id)?;
        jobs.dismiss(&storage, &app, &repository_id)
    })
    .await
    .map_err(|e| AppError::new("task", e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fresh_and_live_owned_locks_are_preserved() {
        let dir = tempfile::tempdir().unwrap();
        assert!(
            Command::new("git")
                .args(["init", "-q"])
                .arg(dir.path())
                .status()
                .unwrap()
                .success()
        );
        release(dir.path()).unwrap();
        let path = dir.path().join(".git/index.lock");
        fs::write(
            &path,
            format!("ReviewBox index lock v1 {} test", std::process::id()),
        )
        .unwrap();
        assert!(release(dir.path()).is_err());
        let file = fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_modified(std::time::SystemTime::now() - Duration::from_secs(60))
            .unwrap();
        assert!(
            release(dir.path())
                .unwrap_err()
                .message
                .contains("still owns")
        );
        assert!(path.exists());
    }
    #[cfg(unix)]
    #[test]
    fn changed_lock_is_never_removed_and_inactive_lock_is_backed_up() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("index.lock");
        fs::write(&path, "original").unwrap();
        let metadata = fs::metadata(&path).unwrap();
        fs::write(&path, "replacement").unwrap();
        assert!(preserve_and_remove(&path, &metadata, b"original").is_err());
        assert_eq!(fs::read(&path).unwrap(), b"replacement");
        let metadata = fs::metadata(&path).unwrap();
        preserve_and_remove(&path, &metadata, b"replacement").unwrap();
        assert!(!path.exists());
        let backup = fs::read_dir(dir.path().join("reviewbox-lock-backups"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(fs::read(backup).unwrap(), b"replacement");
    }
}
