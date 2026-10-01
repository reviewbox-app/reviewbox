//! Explicit, cancellable provider setup. Never accepts shell text from the webview.
use super::providers::{resolve_executable, shell_quote};
use crate::{contracts::*, storage::Storage};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tauri::ipc::Channel;

pub mod updates;

const CODEX_INSTALLER: &str = "https://chatgpt.com/codex/install.sh";
const CLAUDE_INSTALLER: &str = "https://claude.ai/install.sh";

#[derive(Default)]
pub struct SetupManager {
    active: Mutex<HashMap<String, Arc<AtomicBool>>>,
}
impl SetupManager {
    fn register(&self, id: &str) -> AppResult<Arc<AtomicBool>> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| AppError::new("state", "Setup state unavailable."))?;
        if id.is_empty() || id.len() > 128 {
            return Err(AppError::new(
                "setup_operation",
                "Invalid setup operation identifier.",
            ));
        }
        if !active.is_empty() {
            return Err(AppError::new(
                "setup_busy",
                "Wait for the current installation to finish.",
            ));
        }
        let flag = Arc::new(AtomicBool::new(false));
        active.insert(id.into(), flag.clone());
        Ok(flag)
    }
    pub fn cancel(&self, id: &str) -> AppResult<()> {
        if let Some(flag) = self
            .active
            .lock()
            .map_err(|_| AppError::new("state", "Setup state unavailable."))?
            .get(id)
        {
            flag.store(true, Ordering::Relaxed);
        }
        Ok(())
    }
    pub fn stop_all(&self) {
        if let Ok(active) = self.active.lock() {
            for flag in active.values() {
                flag.store(true, Ordering::Relaxed);
            }
        }
    }
    fn remove(&self, id: &str) {
        if let Ok(mut active) = self.active.lock() {
            active.remove(id);
        }
    }
}

enum InstallPlan {
    Native {
        url: &'static str,
        shell: &'static str,
        target: PathBuf,
    },
    Npm {
        executable: PathBuf,
        prefix: PathBuf,
        package: &'static str,
        target: PathBuf,
    },
    Homebrew {
        executable: PathBuf,
        package: &'static str,
        cask: bool,
        target: PathBuf,
    },
    Unsupported,
}

fn plan(config: &ProviderConfig, path: &Path) -> InstallPlan {
    let provider = config.provider.as_str();
    if !["codex", "claude"].contains(&provider) {
        return InstallPlan::Unsupported;
    }
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.into());
    if path
        .components()
        .chain(canonical.components())
        .any(|p| p.as_os_str().to_string_lossy().ends_with(".app"))
    {
        return InstallPlan::Unsupported;
    }
    let text = canonical.to_string_lossy();
    let package = if provider == "codex" {
        "@openai/codex@latest"
    } else {
        "@anthropic-ai/claude-code@latest"
    };
    let suffix = if provider == "codex" {
        "/lib/node_modules/@openai/codex/bin/codex.js"
    } else {
        "/lib/node_modules/@anthropic-ai/claude-code/cli.js"
    };
    if let Some(prefix) = text.strip_suffix(suffix) {
        let prefix = PathBuf::from(prefix);
        return InstallPlan::Npm {
            executable: prefix.join("bin/npm"),
            target: prefix.join("bin").join(provider),
            prefix,
            package,
        };
    }
    let casks: &[&'static str] = if provider == "codex" {
        &["codex"]
    } else {
        &["claude-code", "claude-code@latest"]
    };
    for &cask in casks {
        for category in ["Caskroom", "Cellar"] {
            if let Some((prefix, _)) = text.split_once(&format!("/{category}/{cask}/")) {
                let prefix = PathBuf::from(prefix);
                return InstallPlan::Homebrew {
                    executable: prefix.join("bin/brew"),
                    package: cask,
                    cask: category == "Caskroom",
                    target: prefix.join("bin").join(provider),
                };
            }
        }
    }
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return InstallPlan::Unsupported;
    };
    let target = home.join(".local/bin").join(provider);
    let native_root = if provider == "codex" {
        std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".codex"))
            .join("packages/standalone")
    } else {
        home.join(".local/share/claude/versions")
    };
    // A missing custom path is a configuration error, not consent to replace a
    // different installation. Only the usual command or native path is installable.
    let is_new = !path.exists() && (config.executable == provider || path == target);
    if is_new || canonical.starts_with(native_root) {
        return InstallPlan::Native {
            url: if provider == "codex" {
                CODEX_INSTALLER
            } else {
                CLAUDE_INSTALLER
            },
            shell: if provider == "codex" {
                "/bin/sh"
            } else {
                "/bin/bash"
            },
            target,
        };
    }
    InstallPlan::Unsupported
}

pub(super) fn installation(config: &ProviderConfig, path: &Path) -> ProviderInstallation {
    let selected = plan(config, path);
    let (method, command, available) = match &selected {
        InstallPlan::Native { url, shell, .. } => (
            ProviderInstallationMethod::Native,
            Some(format!(
                "curl -fsSL {url} | {}",
                if *shell == "/bin/sh" { "sh" } else { "bash" }
            )),
            true,
        ),
        InstallPlan::Npm {
            executable,
            prefix,
            package,
            ..
        } => (
            ProviderInstallationMethod::Npm,
            Some(format!(
                "{} install --global --prefix {} {package}",
                shell_quote(&executable.to_string_lossy()),
                shell_quote(&prefix.to_string_lossy())
            )),
            executable.is_file(),
        ),
        InstallPlan::Homebrew {
            executable,
            package,
            cask,
            ..
        } => (
            ProviderInstallationMethod::Homebrew,
            Some(format!(
                "{} {}",
                shell_quote(&executable.to_string_lossy()),
                homebrew_arguments(package, *cask).join(" ")
            )),
            executable.is_file(),
        ),
        InstallPlan::Unsupported => (ProviderInstallationMethod::Unsupported, None, false),
    };
    let can_run = cfg!(target_os = "macos") && available;
    ProviderInstallation {
        method,
        command,
        can_run,
        is_update: path.exists(),
        message: if !cfg!(target_os = "macos") {
            "Integrated installation is currently available on macOS. Install through the official provider instructions, then detect again.".into()
        } else if !available {
            "This installation cannot be updated automatically. Use its original installer, or choose another executable in Settings > Rev.".into()
        } else {
            "ReviewBox runs the official installer for this installation. Sign-in remains with the provider.".into()
        },
    }
}

fn configured(storage: &Storage, provider: &str) -> AppResult<ProviderConfig> {
    if !["codex", "claude"].contains(&provider) {
        return Err(AppError::new("provider", "Unsupported harness."));
    }
    super::settings(storage)?
        .providers
        .into_iter()
        .find(|p| p.provider == provider)
        .ok_or_else(|| AppError::new("provider", "Harness configuration is missing."))
}

fn homebrew_arguments(package: &str, cask: bool) -> Vec<&str> {
    if cask {
        vec!["upgrade", "--cask", package]
    } else {
        vec!["upgrade", "--formula", package]
    }
}

struct Progress<'a> {
    request: &'a ProviderSetupRequest,
    channel: &'a Channel<ProviderSetupEvent>,
}
impl Progress<'_> {
    fn send(&self, phase: ProviderSetupPhase, message: impl Into<String>) -> AppResult<()> {
        self.channel
            .send(ProviderSetupEvent {
                operation_id: self.request.operation_id.clone(),
                provider: self.request.provider.clone(),
                phase,
                message: message.into(),
            })
            .map_err(|_| AppError::new("cancelled", "Installation view closed."))
    }
}

pub async fn install(
    storage: &Storage,
    manager: &SetupManager,
    request: ProviderSetupRequest,
    channel: Channel<ProviderSetupEvent>,
) -> AppResult<ProviderStatus> {
    let cancel = manager.register(&request.operation_id)?;
    let progress = Progress {
        request: &request,
        channel: &channel,
    };
    let result = perform(storage, &request.provider, &cancel, &progress).await;
    manager.remove(&request.operation_id);
    match &result {
        Ok(_) => {
            let _ = progress.send(
                ProviderSetupPhase::Complete,
                "Installation complete. Harness detected.",
            );
        }
        Err(error) => {
            let _ = progress.send(
                if error.code == "cancelled" {
                    ProviderSetupPhase::Cancelled
                } else {
                    ProviderSetupPhase::Failed
                },
                &error.message,
            );
        }
    }
    result
}

async fn perform(
    storage: &Storage,
    provider: &str,
    cancel: &AtomicBool,
    progress: &Progress<'_>,
) -> AppResult<ProviderStatus> {
    progress.send(
        ProviderSetupPhase::Checking,
        "Checking the selected installation…",
    )?;
    let config = configured(storage, provider)?;
    let path = resolve_executable(&config.executable);
    if progress
        .request
        .expected_executable
        .as_deref()
        .is_some_and(|expected| path != Path::new(expected))
    {
        return Err(AppError::new(
            "conflict",
            "The selected executable changed. Check updates again before installing.",
        ));
    }
    let status = installation(&config, &path);
    if !status.can_run {
        return Err(AppError::new("setup_unavailable", status.message));
    }
    check_cancel(cancel)?;
    let workspace = tempfile::tempdir()?;
    let target = match plan(&config, &path) {
        InstallPlan::Native { url, shell, target } => {
            progress.send(
                ProviderSetupPhase::Downloading,
                "Downloading the official installer…",
            )?;
            let script = workspace.path().join("install.sh");
            let mut download = tokio::process::Command::new("/usr/bin/curl");
            download
                .args([
                    "-fsSL",
                    "--proto",
                    "=https",
                    "--proto-redir",
                    "=https",
                    "--connect-timeout",
                    "10",
                    "--max-time",
                    "60",
                    url,
                    "--output",
                ])
                .arg(&script);
            run_command(download, workspace.path(), cancel, Duration::from_secs(70)).await?;
            progress.send(
                ProviderSetupPhase::Installing,
                "Running the official installer…",
            )?;
            let mut installer = tokio::process::Command::new(shell);
            installer.arg(script);
            if provider == "codex" {
                // Use the known native launcher; do not inherit an unrelated override.
                installer.env(
                    "CODEX_INSTALL_DIR",
                    target.parent().ok_or_else(|| {
                        AppError::new("setup", "Native installation path unavailable.")
                    })?,
                );
            }
            run_command(
                installer,
                workspace.path(),
                cancel,
                Duration::from_secs(600),
            )
            .await?;
            target
        }
        InstallPlan::Npm {
            executable,
            prefix,
            package,
            target,
        } => {
            progress.send(
                ProviderSetupPhase::Installing,
                "Updating this npm installation…",
            )?;
            let mut command = tokio::process::Command::new(executable);
            command
                .args(["install", "--global", "--prefix"])
                .arg(&prefix)
                .arg(package);
            // npm's env-node launcher must use the node belonging to this NVM prefix.
            let mut paths = vec![prefix.join("bin")];
            paths.extend(
                std::env::var_os("PATH")
                    .map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
                    .unwrap_or_default(),
            );
            if let Ok(path) = std::env::join_paths(paths) {
                command.env("PATH", path);
            }
            run_command(command, workspace.path(), cancel, Duration::from_secs(600)).await?;
            target
        }
        InstallPlan::Homebrew {
            executable,
            package,
            cask,
            target,
        } => {
            progress.send(
                ProviderSetupPhase::Installing,
                "Updating this Homebrew installation…",
            )?;
            let mut command = tokio::process::Command::new(executable);
            command.args(homebrew_arguments(package, cask));
            run_command(command, workspace.path(), cancel, Duration::from_secs(600)).await?;
            target
        }
        InstallPlan::Unsupported => {
            return Err(AppError::new(
                "setup_unavailable",
                "The installation method changed. Detect again.",
            ));
        }
    };
    check_cancel(cancel)?;
    progress.send(
        ProviderSetupPhase::Detecting,
        "Detecting the installed harness…",
    )?;
    let installed = ProviderConfig {
        executable: target.to_string_lossy().into_owned(),
        ..config.clone()
    };
    let detected = super::providers::detect(&installed).await;
    if !detected.available || detected.compatibility != ProviderCompatibility::Compatible {
        return Err(AppError::new(
            "setup_detection",
            "The installer finished, but a supported harness could not be detected. Check its installation and detect again.",
        ));
    }
    check_cancel(cancel)?;
    let mut settings = super::settings(storage)?;
    let current = settings
        .providers
        .iter_mut()
        .find(|p| p.provider == provider)
        .ok_or_else(|| AppError::new("provider", "Harness configuration is missing."))?;
    if current.executable != config.executable {
        return Err(AppError::new(
            "conflict",
            "The executable was changed during installation. Detect again to choose the installed harness.",
        ));
    }
    current.executable = installed.executable;
    super::configure(storage, settings)?;
    Ok(detected)
}

fn check_cancel(cancel: &AtomicBool) -> AppResult<()> {
    if cancel.load(Ordering::Relaxed) {
        Err(AppError::new(
            "cancelled",
            "Installation cancelled. Files already installed by the provider may remain; detect again before retrying.",
        ))
    } else {
        Ok(())
    }
}

async fn run_command(
    mut command: tokio::process::Command,
    directory: &Path,
    cancel: &AtomicBool,
    timeout: Duration,
) -> AppResult<()> {
    check_cancel(cancel)?;
    command
        .current_dir(directory)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(|_| {
        AppError::new(
            "setup_process",
            "The installer could not start. Check the installation command and available tools.",
        )
    })?;
    let _group = crate::processes::ProcessGroup::new(
        child
            .id()
            .ok_or_else(|| AppError::new("process", "Missing installer process ID."))?,
    );
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        check_cancel(cancel)?;
        if let Some(status) = child.try_wait()? {
            return if status.success() {
                Ok(())
            } else {
                Err(AppError::new(
                    "setup_failed",
                    format!(
                        "The installer failed ({status}). Check your network and permissions, then retry or run the displayed command in your terminal."
                    ),
                ))
            };
        }
        if tokio::time::Instant::now() > deadline {
            return Err(AppError::new(
                "setup_timeout",
                "The installer timed out. Its processes were stopped; detect again before retrying.",
            ));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

pub async fn open_login(storage: &Storage, provider: &str) -> AppResult<()> {
    let config = configured(storage, provider)?;
    let path = resolve_executable(&config.executable);
    if !path.is_absolute() || !path.is_file() {
        return Err(AppError::new(
            "provider",
            "Detect an installed harness before signing in.",
        ));
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME")
            .ok_or_else(|| AppError::new("setup", "Home directory unavailable."))?;
        let login = format!(
            "cd {} && {} {}",
            shell_quote(&home.to_string_lossy()),
            shell_quote(&path.to_string_lossy()),
            if provider == "codex" {
                "login"
            } else {
                "auth login"
            }
        );
        // AppleScript and shell quoting are separate boundaries; neither accepts
        // project text. A new Terminal tab keeps the provider's interactive login.
        let literal = login
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n")
            .replace('\r', "\\r");
        let script =
            format!("tell application \"Terminal\"\nactivate\ndo script \"{literal}\"\nend tell");
        let output = tokio::time::timeout(
            Duration::from_secs(15),
            tokio::process::Command::new("/usr/bin/osascript")
                .arg("-e")
                .arg(script)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .kill_on_drop(true)
                .status(),
        )
        .await;
        match output {
            Ok(Ok(status)) if status.success() => Ok(()),
            _ => Err(AppError::new(
                "provider_login",
                "Terminal could not open. Copy the sign-in command and run it in your terminal.",
            )),
        }
    }
    #[cfg(not(target_os = "macos"))]
    Err(AppError::new(
        "provider_login",
        "Copy the sign-in command and run it in your terminal.",
    ))
}

#[cfg(all(test, unix))]
mod tests;
