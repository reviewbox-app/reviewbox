use crate::{contracts::*, processes::ProcessGroup};
use std::{
    fs,
    io::{Read, Seek, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

/// User-triggered Git operations deliberately preserve identity, hooks, signing,
/// credentials and system config. Content commands continue using repositories::git.
pub(super) fn run(
    root: &Path,
    args: &[&str],
    index: Option<&Path>,
    input: &[u8],
    cancel: &AtomicBool,
) -> AppResult<Vec<u8>> {
    if cancel.load(Ordering::Relaxed) {
        return Err(AppError::new("cancelled", "Git operation stopped."));
    }
    let mut command = Command::new("git");
    #[cfg(target_os = "macos")]
    command.env("PATH", macos_git_path(std::env::var_os("PATH").as_deref()));
    command
        .arg("--no-optional-locks")
        .arg("--literal-pathspecs")
        .args(args)
        .current_dir(root)
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_COMMON_DIR")
        .env_remove("GIT_NAMESPACE")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(index) = index {
        command.env("GIT_INDEX_FILE", index);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn()?;
    let group = ProcessGroup::new(child.id());
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let input = input.to_vec();
    let writer = std::thread::spawn(move || stdin.write_all(&input));
    let out = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).map(|_| bytes)
    });
    let err = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr.read_to_end(&mut bytes).map(|_| bytes)
    });
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break Ok(status);
        }
        if cancel.load(Ordering::Relaxed) || started.elapsed() > Duration::from_secs(120) {
            group.terminate();
            let _ = child.kill();
            let _ = child.wait();
            break Err(AppError::new(
                if cancel.load(Ordering::Relaxed) {
                    "cancelled"
                } else {
                    "git_timeout"
                },
                "Git operation stopped. Check the repository before retrying.",
            ));
        }
        std::thread::sleep(Duration::from_millis(30));
    };
    group.terminate();
    let _ = writer.join();
    let output = out
        .join()
        .map_err(|_| AppError::new("git", "Cannot read Git output."))??;
    let error = err
        .join()
        .map_err(|_| AppError::new("git", "Cannot read Git errors."))??;
    let status = status?;
    if !status.success() {
        let detail = String::from_utf8_lossy(if error.is_empty() { &output } else { &error })
            .trim()
            .to_string();
        return Err(AppError::new(
            "git",
            if detail.is_empty() {
                format!(
                    "Git {} failed ({status}). Check your Git hooks, identity and signing configuration.",
                    args.first().unwrap_or(&"operation")
                )
            } else {
                detail
            },
        ));
    }
    Ok(output)
}

/// Finder launches can omit Homebrew, including Git's signing and credential
/// helpers. Keep inherited precedence and only append standard install paths.
#[cfg(target_os = "macos")]
fn macos_git_path(inherited: Option<&std::ffi::OsStr>) -> std::ffi::OsString {
    let mut paths: Vec<PathBuf> = inherited
        .map(std::env::split_paths)
        .into_iter()
        .flatten()
        .collect();
    for path in [
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
        "/opt/homebrew/bin",
        "/usr/local/bin",
    ] {
        let path = PathBuf::from(path);
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    std::env::join_paths(paths).expect("split PATH entries and standard macOS paths are valid")
}

#[cfg(all(test, target_os = "macos"))]
mod environment_tests {
    use super::*;

    #[test]
    fn finder_path_includes_signing_helpers_without_reordering_user_paths() {
        let inherited = std::ffi::OsStr::new("/custom/bin:/usr/bin:/bin:/opt/homebrew/bin");
        let paths: Vec<_> = std::env::split_paths(&macos_git_path(Some(inherited))).collect();
        assert_eq!(
            &paths[..4],
            &[
                PathBuf::from("/custom/bin"),
                PathBuf::from("/usr/bin"),
                PathBuf::from("/bin"),
                PathBuf::from("/opt/homebrew/bin")
            ]
        );
        assert_eq!(
            paths
                .iter()
                .filter(|p| p.as_path() == std::path::Path::new("/opt/homebrew/bin"))
                .count(),
            1
        );
        assert!(paths.contains(&PathBuf::from("/usr/local/bin")));
    }

    #[test]
    fn missing_path_includes_git_and_homebrew() {
        let paths: Vec<_> = std::env::split_paths(&macos_git_path(None)).collect();
        assert!(paths.contains(&PathBuf::from("/usr/bin")));
        assert!(paths.contains(&PathBuf::from("/opt/homebrew/bin")));
        assert!(paths.contains(&PathBuf::from("/usr/local/bin")));
    }
}

pub(super) fn read(root: &Path, args: &[&str]) -> AppResult<Vec<u8>> {
    run(root, args, None, &[], &AtomicBool::new(false))
}
pub(super) fn text(root: &Path, args: &[&str]) -> AppResult<String> {
    let bytes = read(root, args)?;
    Ok(String::from_utf8(bytes)
        .map_err(|_| {
            AppError::new(
                "git_encoding",
                "Git returned a non-UTF-8 path. This repository cannot be displayed safely.",
            )
        })?
        .trim_end_matches('\n')
        .into())
}
pub(super) fn head(root: &Path) -> Option<String> {
    text(root, &["rev-parse", "--verify", "HEAD"]).ok()
}
pub(super) fn git_path(root: &Path, name: &str) -> AppResult<PathBuf> {
    Ok(PathBuf::from(text(
        root,
        &["rev-parse", "--path-format=absolute", "--git-path", name],
    )?))
}

pub(super) struct TempIndex(pub PathBuf);
impl TempIndex {
    pub fn new(root: &Path) -> AppResult<Self> {
        Ok(Self(git_path(root, &format!("reviewbox-{}.index", id()))?))
    }
}
impl Drop for TempIndex {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
        let _ = fs::remove_file(format!("{}.lock", self.0.display()));
    }
}

pub(super) struct IndexLock {
    path: PathBuf,
    pub file: fs::File,
    published: bool,
}
impl IndexLock {
    pub fn acquire(root: &Path) -> AppResult<Self> {
        let path = git_path(root, "index.lock")?;
        recover_lock(&path)?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| AppError::new("index_locked", format!("The Git index is busy: {e}")))?;
        // This recognizable marker is never an index. Git only checks the lock's
        // existence. It allows safe recovery after the owning process has exited.
        file.write_all(
            format!("ReviewBox index lock v1 {} {}\n", std::process::id(), id()).as_bytes(),
        )?;
        file.sync_all()?;
        Ok(Self {
            path,
            file,
            published: false,
        })
    }
    pub fn publish(&mut self, root: &Path, source: &Path) -> AppResult<()> {
        self.file.rewind()?;
        self.file.set_len(0)?;
        self.file.write_all(&fs::read(source)?)?;
        self.file
            .set_times(fs::FileTimes::new().set_modified(fs::metadata(source)?.modified()?))?;
        self.file.sync_all()?;
        fs::rename(&self.path, git_path(root, "index")?)?;
        self.published = true;
        Ok(())
    }
}
impl Drop for IndexLock {
    fn drop(&mut self) {
        if !self.published {
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                if let (Ok(path), Ok(file)) = (fs::metadata(&self.path), self.file.metadata())
                    && path.dev() == file.dev()
                    && path.ino() == file.ino()
                {
                    let _ = fs::remove_file(&self.path);
                }
            }
            #[cfg(not(unix))]
            {
                let _ = fs::remove_file(&self.path);
            }
        }
    }
}

/// Recover only an identifiable ReviewBox reservation after its process died.
/// Foreign Git locks (including unfinished real indexes) remain untouched.
fn recover_lock(path: &Path) -> AppResult<()> {
    #[cfg(unix)]
    {
        let Ok(bytes) = fs::read(path) else {
            return Ok(());
        };
        let Ok(text) = std::str::from_utf8(&bytes) else {
            return Ok(());
        };
        let Some(rest) = text.strip_prefix("ReviewBox index lock v1 ") else {
            return Ok(());
        };
        let Some((pid, nonce)) = rest.trim_end().split_once(' ') else {
            return Ok(());
        };
        let Ok(pid) = pid.parse::<u32>() else {
            return Ok(());
        };
        if pid == 0 || uuid::Uuid::parse_str(nonce).is_err() {
            return Ok(());
        }
        let output = Command::new("kill")
            .args(["-0", &pid.to_string()])
            .env("LC_ALL", "C")
            .output()?;
        if !output.status.success()
            && String::from_utf8_lossy(&output.stderr)
                .to_lowercase()
                .contains("no such process")
            && fs::read(path)? == bytes
        {
            fs::remove_file(path)?;
        }
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}
