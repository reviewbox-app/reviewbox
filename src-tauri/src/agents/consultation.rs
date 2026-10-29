//! OS-enforced read-only consultation. Never silently run without isolation.
use super::*;
use std::path::Path;

pub(super) struct Sandbox {
    scratch: tempfile::TempDir,
}
impl Sandbox {
    pub(super) fn new() -> AppResult<Self> {
        if !cfg!(target_os = "macos") || !Path::new("/usr/bin/sandbox-exec").is_file() {
            return Err(AppError::new(
                "consultation_unavailable",
                "This system cannot isolate Claude's consultation terminal. Ask Rev is unavailable for this harness.",
            ));
        }
        Ok(Self {
            scratch: tempfile::tempdir()?,
        })
    }
    pub(super) fn command(&self, executable: &Path) -> AppResult<tokio::process::Command> {
        let path = self.scratch.path().canonicalize()?;
        let profile = format!(
            "(version 1)(allow default)(deny file-write*)(allow file-write* (subpath {})(literal \"/dev/null\"))",
            serde_json::to_string(&path.to_string_lossy())?
        );
        let mut command = providers::command(executable);
        // Preserve the executable-aware PATH, but put the OS sandbox before it.
        let path_env = command
            .as_std()
            .get_envs()
            .find(|(key, _)| *key == "PATH")
            .and_then(|(_, value)| value)
            .map(|v| v.to_owned());
        command = tokio::process::Command::new("/usr/bin/sandbox-exec");
        command.args(["-p", &profile]).arg(executable);
        if let Some(path_env) = path_env {
            command.env("PATH", path_env);
        }
        command
            .env("TMPDIR", &path)
            .env("CLAUDE_CODE_TMPDIR", &path);
        Ok(command)
    }
}
#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    #[tokio::test]
    async fn consultation_sandbox_allows_reads_but_denies_external_writes() {
        let sandbox = Sandbox::new().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let source = outside.path().join("source");
        std::fs::write(&source, "original").unwrap();
        let mut command = sandbox.command(Path::new("/bin/sh")).unwrap();
        command
            .args(["-c", "cat \"$1\"; printf changed > \"$1\"", "sh"])
            .arg(&source);
        let output = command.output().await.unwrap();
        assert_eq!(String::from_utf8_lossy(&output.stdout), "original");
        assert!(!output.status.success());
        assert_eq!(std::fs::read_to_string(source).unwrap(), "original");
    }
}
