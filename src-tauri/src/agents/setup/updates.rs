//! Read-only release checks for the same installation selected by setup.
use super::{InstallPlan, configured, plan};
use crate::{contracts::*, storage::Storage};
use semver::Version;
use std::{path::Path, time::Duration};
use tokio::io::AsyncReadExt;

const LIMIT: usize = 1024 * 1024;

fn check_error() -> AppError {
    AppError::new(
        "update_check",
        "Could not check for updates. Check your network and installer, then try again.",
    )
}

fn metadata_error() -> AppError {
    AppError::new(
        "update_metadata",
        "The update service returned an unreadable version. Try again or use the original installer.",
    )
}

fn version(provider: &str, output: &str) -> AppResult<Version> {
    let text = if provider == "codex" {
        output
            .trim()
            .strip_prefix("codex-cli ")
            .or_else(|| output.trim().strip_prefix("codex "))
    } else {
        output.split_whitespace().next()
    };
    text.and_then(|text| Version::parse(text.trim()).ok()).ok_or_else(|| {
        AppError::new("update_version", "Cannot read the installed harness version. Choose an official executable and detect again.")
    })
}

fn release_version(bytes: &[u8], field: Option<&str>) -> AppResult<Version> {
    let value = match field {
        Some(field) => serde_json::from_slice::<serde_json::Value>(bytes)
            .ok()
            .and_then(|value| {
                value
                    .pointer(field)
                    .and_then(|value| value.as_str())
                    .map(str::to_owned)
            }),
        None => match serde_json::from_slice::<serde_json::Value>(bytes) {
            Ok(serde_json::Value::String(value)) => Some(value),
            // npm view may return a one-element array even for the latest tag.
            // Multiple releases are ambiguous: never guess which one to install.
            Ok(serde_json::Value::Array(values)) if values.len() == 1 => {
                values[0].as_str().map(str::to_owned)
            }
            Ok(_) => None,
            Err(_) => std::str::from_utf8(bytes).ok().map(|s| s.trim().to_owned()),
        },
    }
    .ok_or_else(metadata_error)?;
    Version::parse(value.strip_prefix("rust-v").unwrap_or(&value)).map_err(|_| metadata_error())
}

async fn fetch(url: &str) -> AppResult<Vec<u8>> {
    let client = reqwest::Client::builder()
        .https_only(true)
        .timeout(Duration::from_secs(20))
        .user_agent("ReviewBox update check")
        .build()
        .map_err(|_| check_error())?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|_| check_error())?
        .error_for_status()
        .map_err(|_| check_error())?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| check_error())? {
        if bytes.len() + chunk.len() > LIMIT {
            return Err(check_error());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn npm_release(executable: &Path, prefix: &Path, package: &str) -> AppResult<Version> {
    let mut command = tokio::process::Command::new(executable);
    command
        .args(["view", package, "version", "--json"])
        .current_dir(prefix)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let mut paths = vec![prefix.join("bin")];
    paths.extend(
        std::env::var_os("PATH")
            .map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
            .unwrap_or_default(),
    );
    if let Ok(path) = std::env::join_paths(paths) {
        command.env("PATH", path);
    }
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(|_| {
        AppError::new("update_process", "Could not start npm to check for updates. Check the selected installation and its Node.js executable.")
    })?;
    let _group = crate::processes::ProcessGroup::new(child.id().ok_or_else(check_error)?);
    let mut output = child.stdout.take().ok_or_else(check_error)?.take(65537);
    let read = async {
        let mut bytes = Vec::new();
        output
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| check_error())?;
        if bytes.len() > 65536 {
            return Err(check_error());
        }
        let status = child.wait().await.map_err(|_| check_error())?;
        if !status.success() {
            return Err(AppError::new(
                "update_process",
                format!(
                    "Could not check for updates: npm failed ({status}). Check its registry, network access and permissions."
                ),
            ));
        }
        release_version(&bytes, None)
    };
    tokio::time::timeout(Duration::from_secs(20), read)
        .await
        .map_err(|_| {
            AppError::new(
                "update_timeout",
                "Checking for updates with npm timed out. Try again.",
            )
        })?
}

async fn latest(plan: InstallPlan, provider: &str) -> AppResult<Version> {
    match plan {
        InstallPlan::Npm {
            executable,
            prefix,
            package,
            ..
        } => npm_release(&executable, &prefix, package).await,
        InstallPlan::Homebrew { package, cask, .. } => {
            let category = if cask { "cask" } else { "formula" };
            let bytes = fetch(&format!(
                "https://formulae.brew.sh/api/{category}/{package}.json"
            ))
            .await?;
            release_version(
                &bytes,
                Some(if cask { "/version" } else { "/versions/stable" }),
            )
        }
        InstallPlan::Native { .. } if provider == "codex" => {
            let bytes = fetch("https://releases.openai.com/codex/channels/latest").await?;
            release_version(&bytes, Some("/tag_name"))
        }
        InstallPlan::Native { .. } => {
            let bytes = fetch("https://downloads.claude.ai/claude-code-releases/latest").await?;
            release_version(&bytes, None)
        }
        InstallPlan::Unsupported => Err(AppError::new(
            "setup_unavailable",
            "This installation cannot be updated automatically. Use its original installer, or choose another executable.",
        )),
    }
}

pub async fn check(storage: &Storage, provider: &str) -> AppResult<ProviderUpdateCheck> {
    let config = configured(storage, provider)?;
    let status = super::super::providers::detect(&config).await;
    let installed = version(provider, status.version.as_deref().unwrap_or(""))?;
    let latest = latest(plan(&config, Path::new(&status.executable)), provider).await?;
    Ok(ProviderUpdateCheck {
        update_available: latest.cmp_precedence(&installed).is_gt(),
        latest_version: latest.to_string(),
        status,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_formats_and_numeric_comparison() {
        for (body, field) in [
            (r#""0.160.0""#, None),
            (r#"["0.160.0"]"#, None),
            (r#"{"tag_name":"rust-v0.160.0"}"#, Some("/tag_name")),
            (r#"{"version":"0.160.0"}"#, Some("/version")),
            (
                r#"{"versions":{"stable":"0.160.0"}}"#,
                Some("/versions/stable"),
            ),
            ("0.160.0\n", None),
        ] {
            let latest = release_version(body.as_bytes(), field).unwrap();
            assert!(latest > version("codex", "codex-cli 0.99.0").unwrap());
            assert_eq!(latest, version("codex", "codex 0.160.0").unwrap());
            assert!(latest < version("codex", "codex-cli 0.161.0-beta.1").unwrap());
        }
        assert_eq!(
            version("claude", "2.1.282 (Claude Code)").unwrap(),
            Version::new(2, 1, 282)
        );
        for body in [
            "<html>offline</html>",
            "latest",
            "{}",
            "0.160",
            "[]",
            "[null]",
            r#"["0.159.0","0.160.0"]"#,
        ] {
            assert_eq!(
                release_version(body.as_bytes(), None).unwrap_err().code,
                "update_metadata"
            );
        }
        assert!(version("codex", "unknown").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn npm_check_is_read_only_and_errors_do_not_claim_up_to_date() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let npm = dir.path().join("npm");
        std::fs::write(&npm, "#!/bin/sh\n[ \"$*\" = 'view @openai/codex@latest version --json' ] || exit 2\nprintf '[\"0.160.0\"]'\n").unwrap();
        std::fs::set_permissions(&npm, std::fs::Permissions::from_mode(0o700)).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            assert_eq!(
                npm_release(&npm, dir.path(), "@openai/codex@latest")
                    .await
                    .unwrap(),
                Version::new(0, 160, 0)
            );
            assert!(npm_release(&npm, dir.path(), "unexpected").await.is_err());
        });
    }
}
