//! Local readiness probes. Credentials and raw authentication output never cross IPC.
//! Protocol capabilities are still negotiated before every agent session.
use crate::contracts::{
    AppError, AppResult, ProviderAuthentication, ProviderCompatibility, ProviderConfig,
    ProviderStatus,
};
use semver::Version;
use std::path::{Path, PathBuf};

// ReviewBox's supported baseline, independent of the newest published release.
pub const CODEX_MINIMUM_VERSION: &str = "0.157.0";

fn codex_version(output: &str) -> Option<Version> {
    let value = output
        .trim()
        .strip_prefix("codex-cli ")
        .or_else(|| output.trim().strip_prefix("codex "))?;
    Version::parse(value.trim()).ok()
}

fn compatibility(output: &str) -> ProviderCompatibility {
    match codex_version(output) {
        Some(version)
            if version < Version::parse(CODEX_MINIMUM_VERSION).expect("valid minimum") =>
        {
            ProviderCompatibility::Outdated
        }
        Some(_) => ProviderCompatibility::Compatible,
        None => ProviderCompatibility::Unknown,
    }
}

pub(super) fn resolve_executable(executable: &str) -> PathBuf {
    let path = PathBuf::from(executable);
    if path.components().count() > 1 || path.is_absolute() {
        return path;
    }
    let mut candidates: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|paths| {
            std::env::split_paths(&paths)
                .map(|p| p.join(executable))
                .collect()
        })
        .unwrap_or_default();
    if let Some(home) = std::env::var_os("HOME") {
        candidates.push(PathBuf::from(home).join(".local/bin").join(executable));
    }
    for prefix in ["/opt/homebrew/bin", "/usr/local/bin"] {
        candidates.push(Path::new(prefix).join(executable));
    }
    candidates.into_iter().find(|p| p.is_file()).unwrap_or(path)
}

/// Finder does not inherit the terminal's NVM PATH. Keep the selected CLI's
/// runtime directory ahead of inherited entries, without running shell profiles.
pub(super) fn command(path: &Path) -> tokio::process::Command {
    command_with_path(path, std::env::var_os("PATH").as_deref())
}

fn command_with_path(path: &Path, inherited: Option<&std::ffi::OsStr>) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(path);
    let mut paths = Vec::new();
    if path.is_absolute()
        && let Some(parent) = path.parent()
    {
        paths.push(parent.to_owned());
    }
    if let Some(inherited) = inherited {
        paths.extend(std::env::split_paths(inherited));
    }
    if !paths.is_empty()
        && let Ok(path) = std::env::join_paths(paths)
    {
        command.env("PATH", path);
    }
    command
}

pub(super) fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn update_guidance(path: &Path) -> (Option<String>, String) {
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_owned());
    if path
        .components()
        .chain(canonical.components())
        .any(|p| p.as_os_str().to_string_lossy().ends_with(".app"))
    {
        return (None, "Update the application that bundles this executable, or choose another Codex executable below.".into());
    }
    let text = canonical.to_string_lossy();
    if text.contains("/Caskroom/codex/") {
        return (
            Some("brew upgrade --cask codex".into()),
            "Run this command in your terminal, then detect again.".into(),
        );
    }
    if let Some(prefix) = text.strip_suffix("/lib/node_modules/@openai/codex/bin/codex.js") {
        return (Some(format!("npm install --global --prefix {} @openai/codex@latest", shell_quote(prefix))), "Run this command in your terminal, then detect again. The explicit prefix updates this installation, including NVM installations.".into());
    }
    (None, "The installation method could not be identified. Update Codex using its original installer, or choose another executable below, then detect again.".into())
}

pub async fn detect(config: &ProviderConfig) -> ProviderStatus {
    let path = resolve_executable(&config.executable);
    let is_codex = config.provider == "codex";
    let mut status = ProviderStatus {
        authentication: ProviderAuthentication::Unavailable,
        ready: false,
        installation: super::setup::installation(config, &path),
        login_command: None,
        provider: config.provider.clone(),
        available: false,
        version: None,
        compatibility: ProviderCompatibility::Unavailable,
        minimum_version: is_codex.then(|| CODEX_MINIMUM_VERSION.into()),
        executable: path.to_string_lossy().into_owned(),
        update_command: None,
        update_instructions: None,
        message: "Executable unavailable or version detection timed out. Configure its full path in Settings > Rev.".into(),
    };
    if let Some((success, stdout, _)) = probe(&path, &["--version"]).await
        && success
    {
        let version: String = String::from_utf8_lossy(&stdout)
            .trim()
            .chars()
            .take(256)
            .collect();
        status.available = true;
        status.compatibility = if is_codex {
            compatibility(&version)
        } else if version
            .split_whitespace()
            .next()
            .and_then(|v| Version::parse(v).ok())
            .is_some()
        {
            ProviderCompatibility::Compatible
        } else {
            ProviderCompatibility::Unknown
        };
        status.message = match status.compatibility {
                ProviderCompatibility::Compatible => "Version supported.".into(),
                ProviderCompatibility::Outdated => format!("Codex is too old. ReviewBox requires {CODEX_MINIMUM_VERSION} or later. Update it in Settings > Rev; manual reviews remain available."),
                _ => "Cannot read the harness version. Select an official CLI executable in Settings > Rev before starting an AI request.".into(),
            };
        status.version = Some(version);
        status.login_command = Some(format!(
            "{} {}",
            shell_quote(&path.to_string_lossy()),
            if is_codex { "login" } else { "auth login" }
        ));
        status.authentication = authenticate(&path, is_codex).await;
        status.ready = status.compatibility == ProviderCompatibility::Compatible
            && status.authentication == ProviderAuthentication::Authenticated;
        if status.compatibility == ProviderCompatibility::Compatible {
            status.message = match status.authentication {
                ProviderAuthentication::Authenticated => "Ready. Signed in through the harness.".into(),
                ProviderAuthentication::SignedOut => "Sign in through the harness, then detect again.".into(),
                _ => "Could not verify the harness sign-in. Check its configuration in your terminal, then detect again.".into(),
            };
        }
    }
    if is_codex && status.compatibility != ProviderCompatibility::Compatible {
        let (command, instructions) = update_guidance(&path);
        status.update_command = command;
        status.update_instructions = Some(instructions);
    }
    status
}

pub async fn require_codex_version(config: &ProviderConfig) -> AppResult<()> {
    // Session gating does not need a second authentication probe; the adapter reports
    // authentication failures itself, without masking protocol negotiation errors.
    let path = resolve_executable(&config.executable);
    if !matches!(probe(&path, &["--version"]).await,
        Some((true, output, _)) if compatibility(&String::from_utf8_lossy(&output)) == ProviderCompatibility::Compatible)
    {
        return Err(AppError::new(
            "incompatible_provider",
            format!(
                "ReviewBox requires Codex {CODEX_MINIMUM_VERSION} or later. Update or select its executable in Settings > Rev."
            ),
        ));
    }
    Ok(())
}

async fn authenticate(path: &Path, codex: bool) -> ProviderAuthentication {
    let args: &[&str] = if codex {
        &["login", "status"]
    } else {
        &["auth", "status", "--json"]
    };
    let Some((success, stdout, stderr)) = probe(path, args).await else {
        return ProviderAuthentication::Unknown;
    };
    if codex {
        if success {
            return ProviderAuthentication::Authenticated;
        }
        let output = format!(
            "{} {}",
            String::from_utf8_lossy(&stdout),
            String::from_utf8_lossy(&stderr)
        )
        .to_ascii_lowercase();
        if output.contains("not logged in") || output.contains("not signed in") {
            ProviderAuthentication::SignedOut
        } else {
            ProviderAuthentication::Unknown
        }
    } else {
        match serde_json::from_slice::<serde_json::Value>(&stdout)
            .ok()
            .and_then(|v| v.get("loggedIn").and_then(|v| v.as_bool()))
        {
            Some(true) if success => ProviderAuthentication::Authenticated,
            Some(false) => ProviderAuthentication::SignedOut,
            _ => ProviderAuthentication::Unknown,
        }
    }
}

async fn probe(path: &Path, args: &[&str]) -> Option<(bool, Vec<u8>, Vec<u8>)> {
    use tokio::io::AsyncReadExt;
    let mut command = command(path);
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    if let Some(home) = std::env::var_os("HOME") {
        command.current_dir(home);
    }
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().ok()?;
    let _group = crate::processes::ProcessGroup::new(child.id()?);
    let mut out = child.stdout.take()?.take(65536);
    let mut err = child.stderr.take()?.take(65536);
    let stdout = tokio::spawn(async move {
        let mut stdout = Vec::new();
        out.read_to_end(&mut stdout).await.ok()?;
        Some(stdout)
    });
    let stderr = tokio::spawn(async move {
        let mut stderr = Vec::new();
        err.read_to_end(&mut stderr).await.ok()?;
        Some(stderr)
    });
    let operation = async {
        Some((
            child.wait().await.ok()?.success(),
            stdout.await.ok()??,
            stderr.await.ok()??,
        ))
    };
    tokio::time::timeout(std::time::Duration::from_secs(5), operation)
        .await
        .ok()
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn npm_launcher_uses_sibling_runtime_with_desktop_path() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let directory = tempfile::tempdir().unwrap();
        let bin = directory.path().join("nvm installation/bin");
        let package = directory.path().join("package");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&package).unwrap();
        let runtime = bin.join("reviewbox-test-runtime");
        std::fs::write(&runtime, "#!/bin/sh\ncase \"$2\" in --version) echo 'codex-cli 0.157.0';; login) echo 'Logged in using ChatGPT';; *) exit 1;; esac\n").unwrap();
        std::fs::set_permissions(&runtime, std::fs::Permissions::from_mode(0o700)).unwrap();
        let script = package.join("codex.js");
        std::fs::write(&script, "#!/usr/bin/env reviewbox-test-runtime\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let executable = bin.join("codex");
        symlink(script, &executable).unwrap();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        for args in [vec!["--version"], vec!["login", "status"]] {
            let output = rt
                .block_on(async {
                    command_with_path(&executable, Some(std::ffi::OsStr::new("/usr/bin:/bin")))
                        .args(args)
                        .output()
                        .await
                })
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        let config = ProviderConfig {
            provider: "codex".into(),
            executable: executable.to_string_lossy().into_owned(),
            model: None,
        };
        let status = rt.block_on(detect(&config));
        assert!(status.ready);
        assert_eq!(status.version.as_deref(), Some("codex-cli 0.157.0"));
        assert!(rt.block_on(require_codex_version(&config)).is_ok());
    }

    #[test]
    fn numeric_versions_and_prereleases() {
        for version in ["0.99.0", "0.147.0", "0.157.0-alpha.1"] {
            assert_eq!(
                compatibility(&format!("codex-cli {version}")),
                ProviderCompatibility::Outdated
            );
        }
        for version in [
            "0.157.0",
            "0.157.0+build.4",
            "0.158.0-alpha.2.1",
            "0.1000.0",
            "1.0.0",
        ] {
            assert_eq!(
                compatibility(&format!("codex-cli {version}\n")),
                ProviderCompatibility::Compatible
            );
        }
        for text in [
            "",
            "Claude 0.157.0",
            "codex-cli unknown",
            "codex-cli 0.157.0 other",
        ] {
            assert_eq!(compatibility(text), ProviderCompatibility::Unknown);
        }
    }
    #[test]
    fn installation_specific_guidance() {
        let (command, _) = update_guidance(Path::new(
            "/Users/example/.nvm/versions/node/v24/lib/node_modules/@openai/codex/bin/codex.js",
        ));
        assert_eq!(
            command.unwrap(),
            "npm install --global --prefix '/Users/example/.nvm/versions/node/v24' @openai/codex@latest"
        );
        assert!(
            update_guidance(Path::new(
                "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"
            ))
            .0
            .is_none()
        );
        assert_eq!(
            update_guidance(Path::new("/opt/homebrew/Caskroom/codex/0.147.0/codex"))
                .0
                .unwrap(),
            "brew upgrade --cask codex"
        );
        assert!(update_guidance(Path::new("/custom/codex")).0.is_none());
        assert_eq!(
            shell_quote("/a b/o'neil/$HOME"),
            "'/a b/o'\"'\"'neil/$HOME'"
        );
    }
    #[cfg(unix)]
    #[test]
    fn npm_symlink_preserves_installation_prefix() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let target = dir
            .path()
            .join("lib/node_modules/@openai/codex/bin/codex.js");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, "").unwrap();
        let link = dir.path().join("codex");
        symlink(target, &link).unwrap();
        assert!(update_guidance(&link).0.unwrap().contains(&shell_quote(
            &std::fs::canonicalize(dir.path()).unwrap().to_string_lossy()
        )));
    }
    #[cfg(unix)]
    #[test]
    fn native_gate_stops_before_app_server_and_detects_replaced_binary() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("codex");
        let calls = dir.path().join("calls");
        let config = ProviderConfig {
            provider: "codex".into(),
            executable: binary.to_string_lossy().into(),
            model: None,
        };
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        for (output, expected) in [
            ("codex-cli 0.147.0", ProviderCompatibility::Outdated),
            ("unparseable", ProviderCompatibility::Unknown),
            ("codex-cli 0.157.0", ProviderCompatibility::Compatible),
        ] {
            std::fs::write(&binary, format!("#!/bin/sh\necho \"$*\" >> {}\nif [ \"$1\" = --version ]; then echo '{}'; else exit 1; fi\n", shell_quote(&calls.to_string_lossy()), output)).unwrap();
            std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
            let status = runtime.block_on(detect(&config));
            assert_eq!(status.compatibility, expected);
            let result = runtime.block_on(require_codex_version(&config));
            assert_eq!(
                result.is_ok(),
                expected == ProviderCompatibility::Compatible
            );
            if expected != ProviderCompatibility::Compatible {
                let mut stream = crate::agents::Stream {
                    id: "test".into(),
                    sequence: 0,
                    channel: tauri::ipc::Channel::new(|_| Ok(())),
                    text: String::new(),
                    preview: None,
                };
                let error = runtime
                    .block_on(crate::agents::codex::run(
                        dir.path(),
                        "",
                        &config,
                        std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                        &mut stream,
                    ))
                    .unwrap_err();
                assert_eq!(error.code, "incompatible_provider");
            }
        }
        assert!(
            std::fs::read_to_string(calls)
                .unwrap()
                .lines()
                .all(|line| line == "--version" || line == "login status")
        );
        // Version support never bypasses the existing protocol check.
        let mut stream = crate::agents::Stream {
            id: "test".into(),
            sequence: 0,
            channel: tauri::ipc::Channel::new(|_| Ok(())),
            text: String::new(),
            preview: None,
        };
        let error = runtime
            .block_on(crate::agents::codex::run(
                dir.path(),
                "",
                &config,
                std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                &mut stream,
            ))
            .unwrap_err();
        assert!(error.message.contains("Cannot inspect"));
        std::fs::remove_file(binary).unwrap();
        assert_eq!(
            runtime.block_on(detect(&config)).compatibility,
            ProviderCompatibility::Unavailable
        );
        assert!(runtime.block_on(require_codex_version(&config)).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn readiness_distinguishes_sign_in_from_configuration_failure() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("harness");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        for (provider, output, expected, ready) in [
            (
                "codex",
                "echo 'Logged in using ChatGPT'; exit 0",
                ProviderAuthentication::Authenticated,
                true,
            ),
            (
                "codex",
                "echo 'Not logged in' >&2; exit 1",
                ProviderAuthentication::SignedOut,
                false,
            ),
            (
                "codex",
                "echo 'Error loading config secret123' >&2; exit 1",
                ProviderAuthentication::Unknown,
                false,
            ),
            (
                "claude",
                "echo '{\"loggedIn\":true,\"email\":\"private@example.org\"}'; exit 0",
                ProviderAuthentication::Authenticated,
                true,
            ),
            (
                "claude",
                "echo '{\"loggedIn\":false}'; exit 1",
                ProviderAuthentication::SignedOut,
                false,
            ),
            (
                "claude",
                "echo 'invalid credentials secret123'; exit 1",
                ProviderAuthentication::Unknown,
                false,
            ),
        ] {
            let version = if provider == "codex" {
                "codex-cli 0.157.0"
            } else {
                "2.1.281 (Claude Code)"
            };
            std::fs::write(&path, format!("#!/bin/sh\nif [ \"$1\" = --version ]; then echo '{version}'; exit 0; fi\n{output}\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
            let config = ProviderConfig {
                provider: provider.into(),
                executable: path.to_string_lossy().into_owned(),
                model: None,
            };
            let status = runtime.block_on(detect(&config));
            assert_eq!(status.authentication, expected);
            assert_eq!(status.ready, ready);
            let wire = serde_json::to_string(&status).unwrap();
            assert!(!wire.contains("private@example.org"));
            assert!(!wire.contains("secret123"));
        }
    }
}
