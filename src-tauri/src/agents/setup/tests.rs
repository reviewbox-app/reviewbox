use super::*;
use std::os::unix::{
    fs::{PermissionsExt, symlink},
    process::ExitStatusExt,
};

fn executable(path: &Path, body: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
}
fn config(path: &Path) -> ProviderConfig {
    ProviderConfig {
        reasoning_effort: None,
        provider: "codex".into(),
        executable: path.to_string_lossy().into(),
        model: None,
    }
}

#[test]
fn installation_plans_keep_exact_prefix_and_reject_unknown_paths() {
    let dir = tempfile::tempdir().unwrap();
    let prefix = dir.path().join("an nvm prefix");
    let target = prefix.join("lib/node_modules/@openai/codex/bin/codex.js");
    executable(&target, "exit 0");
    let npm = prefix.join("bin/npm");
    executable(&npm, "exit 0");
    let link = prefix.join("bin/codex");
    symlink(&target, &link).unwrap();
    match plan(&config(&link), &link) {
        InstallPlan::Npm {
            executable,
            prefix: actual,
            target: actual_target,
            package,
        } => {
            assert_eq!(executable, std::fs::canonicalize(npm).unwrap());
            assert_eq!(actual, std::fs::canonicalize(prefix).unwrap());
            assert_eq!(actual_target.file_name().unwrap(), "codex");
            assert_eq!(package, "@openai/codex@latest");
        }
        _ => panic!("expected the npm install"),
    }
    assert!(
        !installation(
            &config(Path::new("/custom/codex")),
            Path::new("/custom/codex")
        )
        .can_run
    );
    let path = Path::new("/Applications/Codex.app/Contents/Resources/codex");
    assert!(matches!(
        plan(&config(path), path),
        InstallPlan::Unsupported
    ));
    for (path, package, cask) in [
        ("/opt/homebrew/Caskroom/codex/1.0.0/codex", "codex", true),
        ("/usr/local/Cellar/codex/1.0.0/bin/codex", "codex", false),
    ] {
        match plan(&config(Path::new(path)), Path::new(path)) {
            InstallPlan::Homebrew {
                package: actual,
                cask: actual_cask,
                ..
            } => {
                assert_eq!(actual, package);
                assert_eq!(actual_cask, cask);
                let flag = if cask { "--cask" } else { "--formula" };
                assert!(
                    installation(&config(Path::new(path)), Path::new(path))
                        .command
                        .unwrap()
                        .ends_with(&format!("upgrade {flag} {package}"))
                );
            }
            _ => panic!("expected Homebrew"),
        }
    }
}

#[test]
fn only_one_owned_operation_runs_and_can_be_cancelled() {
    let manager = SetupManager::default();
    let first = manager.register("one").unwrap();
    assert_eq!(manager.register("two").unwrap_err().code, "setup_busy");
    manager.cancel("one").unwrap();
    assert!(first.load(Ordering::Relaxed));
    manager.remove("one");
    assert!(manager.register("two").is_ok());
    manager.stop_all();
}

#[test]
fn subprocess_failure_timeout_and_cancellation_cleanup() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let cancel = AtomicBool::new(false);
        let mut ok = tokio::process::Command::new("/bin/sh");
        ok.args(["-c", "exit 0"]);
        run_command(ok, dir.path(), &cancel, Duration::from_secs(1))
            .await
            .unwrap();
        let mut fail = tokio::process::Command::new("/bin/sh");
        fail.args(["-c", "echo secret-credential >&2; exit 7"]);
        let error = run_command(fail, dir.path(), &cancel, Duration::from_secs(1))
            .await
            .unwrap_err();
        assert_eq!(error.code, "setup_failed");
        assert!(!error.message.contains("secret-credential"));
        let marker = dir.path().join("survived");
        let mut hanging = tokio::process::Command::new("/bin/sh");
        hanging.arg("-c").arg(format!(
            "(sleep 1; touch {}) & wait",
            shell_quote(&marker.to_string_lossy())
        ));
        assert_eq!(
            run_command(hanging, dir.path(), &cancel, Duration::from_millis(120))
                .await
                .unwrap_err()
                .code,
            "setup_timeout"
        );
        tokio::time::sleep(Duration::from_millis(1100)).await;
        assert!(!marker.exists(), "descendant must not survive timeout");
        let cancelled = AtomicBool::new(true);
        assert_eq!(
            run_command(
                tokio::process::Command::new("/bin/false"),
                dir.path(),
                &cancelled,
                Duration::from_secs(1)
            )
            .await
            .unwrap_err()
            .code,
            "cancelled"
        );
        let active_cancel = Arc::new(AtomicBool::new(false));
        let delayed = active_cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            delayed.store(true, Ordering::Relaxed);
        });
        let mut active = tokio::process::Command::new("/bin/sh");
        active.arg("-c").arg(format!(
            "(sleep 1; touch {}) & wait",
            shell_quote(&marker.to_string_lossy())
        ));
        assert_eq!(
            run_command(active, dir.path(), &active_cancel, Duration::from_secs(3))
                .await
                .unwrap_err()
                .code,
            "cancelled"
        );
        tokio::time::sleep(Duration::from_millis(1100)).await;
        assert!(!marker.exists(), "descendant must not survive cancellation");
    });
    // A signalled exit is a normal installer failure, never a panic.
    assert!(!std::process::ExitStatus::from_raw(9).success());
}

/// All executables and local preferences belong to this temporary directory.
/// The only updater ever spawned is the fixture's shell script, never real npm.
#[cfg(target_os = "macos")]
struct NpmFixture {
    _directory: tempfile::TempDir,
    storage: Storage,
    prefix: PathBuf,
    npm: PathBuf,
    initial: ProviderSettings,
    replacement: PathBuf,
}

#[cfg(target_os = "macos")]
impl NpmFixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let prefix = directory.path().join("test's node prefix");
        let target = prefix.join("lib/node_modules/@openai/codex/bin/codex.js");
        executable(
            &target,
            "if [ \"$1\" = --version ]; then echo 'codex-cli 0.147.0'; else exit 1; fi",
        );
        let npm = prefix.join("bin/npm");
        executable(&npm, "exit 99");
        symlink(&target, prefix.join("bin/codex")).unwrap();
        let initial_path = directory.path().join("original-codex-launcher");
        symlink(&target, &initial_path).unwrap();
        let replacement = directory.path().join("supported-codex");
        executable(
            &replacement,
            "if [ \"$1\" = --version ]; then echo 'codex-cli 0.157.0'; elif [ \"$1 $2\" = 'login status' ]; then echo 'Logged in using ChatGPT with private-fixture-value'; else exit 1; fi",
        );
        let storage = Storage::open(directory.path().join("appdata")).unwrap();
        let initial = crate::agents::configure(
            &storage,
            ProviderSettings {
                helper_model: "gpt-6-luna".into(),
                revision: 0,
                model_defaults_version: 1,
                default_provider: "codex".into(),
                providers: vec![
                    config(&initial_path),
                    ProviderConfig {
                        reasoning_effort: None,
                        provider: "claude".into(),
                        executable: directory
                            .path()
                            .join("missing-claude")
                            .to_string_lossy()
                            .into_owned(),
                        model: None,
                    },
                ],
            },
        )
        .unwrap();
        Self {
            _directory: directory,
            storage,
            prefix,
            npm,
            initial,
            replacement,
        }
    }
    fn channel(
        &self,
    ) -> (
        Channel<ProviderSetupEvent>,
        Arc<Mutex<Vec<serde_json::Value>>>,
    ) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let collected = events.clone();
        let channel = Channel::new(move |body| {
            let event: serde_json::Value = body.deserialize().unwrap();
            collected.lock().unwrap().push(event);
            Ok(())
        });
        (channel, events)
    }
}

#[cfg(target_os = "macos")]
#[test]
fn install_orchestration_updates_only_fixture_and_persists_detected_path() {
    let fixture = NpmFixture::new();
    let args_file = fixture.prefix.join("updater-arguments");
    let exact_prefix = std::fs::canonicalize(&fixture.prefix).unwrap();
    executable(
        &fixture.npm,
        &format!(
            "printf '%s\\n' \"$@\" > {}\n[ \"$1\" = install ] && [ \"$2\" = --global ] && [ \"$3\" = --prefix ] && [ \"$4\" = {} ] && [ \"$5\" = @openai/codex@latest ] || exit 8\ncp {} \"$4/lib/node_modules/@openai/codex/bin/codex.js\"",
            shell_quote(&args_file.to_string_lossy()),
            shell_quote(&exact_prefix.to_string_lossy()),
            shell_quote(&fixture.replacement.to_string_lossy())
        ),
    );
    let manager = SetupManager::default();
    let (channel, collected) = fixture.channel();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let result = runtime
        .block_on(install(
            &fixture.storage,
            &manager,
            ProviderSetupRequest {
                expected_executable: None,
                operation_id: "fixture-install".into(),
                provider: "codex".into(),
            },
            channel,
        ))
        .unwrap();
    assert!(result.ready);
    assert_eq!(result.version.as_deref(), Some("codex-cli 0.157.0"));
    assert_eq!(result.authentication, ProviderAuthentication::Authenticated);
    let expected_path = exact_prefix.join("bin/codex");
    assert_eq!(Path::new(&result.executable), expected_path);
    let saved = crate::agents::settings(&fixture.storage).unwrap();
    assert_eq!(saved.revision, fixture.initial.revision + 1);
    assert_eq!(Path::new(&saved.providers[0].executable), expected_path);
    assert!(Path::new(&saved.providers[0].executable).is_absolute());
    assert_eq!(
        saved.providers[1].executable,
        fixture.initial.providers[1].executable
    );
    assert_eq!(
        std::fs::read_to_string(args_file)
            .unwrap()
            .lines()
            .collect::<Vec<_>>(),
        vec![
            "install",
            "--global",
            "--prefix",
            exact_prefix.to_str().unwrap(),
            "@openai/codex@latest"
        ]
    );
    let events = collected.lock().unwrap();
    assert_eq!(
        events
            .iter()
            .map(|e| e["phase"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["checking", "installing", "detecting", "complete"]
    );
    assert!(
        events
            .iter()
            .all(|e| e["operationId"] == "fixture-install" && e["provider"] == "codex")
    );
    assert!(
        !serde_json::to_string(&*events)
            .unwrap()
            .contains("private-fixture-value")
    );
    assert!(
        !serde_json::to_string(&result)
            .unwrap()
            .contains("private-fixture-value")
    );
    assert!(manager.active.lock().unwrap().is_empty());
}

#[cfg(target_os = "macos")]
#[test]
fn install_cancellation_does_not_publish_success_or_change_preferences() {
    let fixture = NpmFixture::new();
    let started = fixture.prefix.join("updater-started");
    let survived = fixture.prefix.join("descendant-survived");
    executable(
        &fixture.npm,
        &format!(
            "touch {}\n(sleep 1; touch {}) &\nwait\ncp {} \"$4/lib/node_modules/@openai/codex/bin/codex.js\"",
            shell_quote(&started.to_string_lossy()),
            shell_quote(&survived.to_string_lossy()),
            shell_quote(&fixture.replacement.to_string_lossy())
        ),
    );
    let manager = Arc::new(SetupManager::default());
    let (channel, collected) = fixture.channel();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let canceller = manager.clone();
        let cancel_task = tokio::spawn(async move {
            for _ in 0..100 {
                if started.exists() {
                    canceller.cancel("fixture-cancel").unwrap();
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            panic!("The fixture installer never started");
        });
        let result = install(
            &fixture.storage,
            &manager,
            ProviderSetupRequest {
                expected_executable: None,
                operation_id: "fixture-cancel".into(),
                provider: "codex".into(),
            },
            channel,
        )
        .await
        .unwrap_err();
        cancel_task.await.unwrap();
        assert_eq!(result.code, "cancelled");
        let saved = crate::agents::settings(&fixture.storage).unwrap();
        assert_eq!(
            serde_json::to_value(saved).unwrap(),
            serde_json::to_value(&fixture.initial).unwrap()
        );
        let phases = collected
            .lock()
            .unwrap()
            .iter()
            .map(|e| e["phase"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(phases, vec!["checking", "installing", "cancelled"]);
        assert!(manager.active.lock().unwrap().is_empty());
        tokio::time::sleep(Duration::from_millis(1100)).await;
        assert!(
            !survived.exists(),
            "The installer's descendants must be stopped"
        );
        let original = crate::agents::providers::detect(&fixture.initial.providers[0]).await;
        assert_eq!(original.version.as_deref(), Some("codex-cli 0.147.0"));
        assert_eq!(original.compatibility, ProviderCompatibility::Outdated);
    });
}

#[cfg(target_os = "macos")]
#[test]
fn update_confirmation_does_not_authorize_a_different_executable() {
    let fixture = NpmFixture::new();
    let marker = fixture.prefix.join("unexpected-install");
    executable(
        &fixture.npm,
        &format!("touch {}", shell_quote(&marker.to_string_lossy())),
    );
    let (channel, _) = fixture.channel();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let error = runtime
        .block_on(install(
            &fixture.storage,
            &SetupManager::default(),
            ProviderSetupRequest {
                operation_id: "changed-selection".into(),
                provider: "codex".into(),
                expected_executable: Some("/previous/codex".into()),
            },
            channel,
        ))
        .unwrap_err();
    assert_eq!(error.code, "conflict");
    assert!(!marker.exists());
    assert_eq!(
        crate::agents::settings(&fixture.storage).unwrap().revision,
        fixture.initial.revision
    );
}
