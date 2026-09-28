//! Installation recipes for official runtimes whose distribution is not already
//! a relocatable executable tree. Only installer-owned directories are writable.
use crate::{
    contracts::{AppError, AppResult},
    processes::ProcessGroup,
};
use std::{
    collections::BTreeMap,
    fs,
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

fn cancelled(cancel: &AtomicBool) -> AppResult<()> {
    if cancel.load(Ordering::Acquire) {
        Err(AppError::new(
            "cancelled",
            "Runtime installation was cancelled.",
        ))
    } else {
        Ok(())
    }
}

pub(crate) fn preflight(id: &str) -> AppResult<()> {
    if !matches!(id, "runtime-ruby" | "runtime-yaml" | "runtime-openssl") {
        return Ok(());
    }
    let tools: &[&str] = if id == "runtime-openssl" {
        &["cc", "make", "perl"]
    } else {
        &["cc", "make"]
    };
    for tool in tools {
        if !Command::new(tool)
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
        {
            return Err(AppError::new(
                "missing_language_prerequisite",
                format!("Building {id} requires existing compiler tools. {tool} is unavailable."),
            ));
        }
    }
    Ok(())
}

pub(crate) struct BuildPaths<'a> {
    pub source: &'a Path,
    pub staging: &'a Path,
    pub final_prefix: &'a Path,
    pub dependencies: &'a BTreeMap<String, PathBuf>,
}

fn run(command: &mut Command, cancel: &AtomicBool, log: &Path, label: &str) -> AppResult<()> {
    cancelled(cancel)?;
    let output = fs::OpenOptions::new().create(true).append(true).open(log)?;
    command
        .stdin(Stdio::null())
        .stdout(output.try_clone()?)
        .stderr(output);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|error| {
        AppError::new(
            "language_runtime_build",
            format!("Cannot start {label}: {error}"),
        )
    })?;
    let group = ProcessGroup::new(child.id());
    let started = Instant::now();
    loop {
        if cancel.load(Ordering::Acquire) || started.elapsed() > Duration::from_secs(30 * 60) {
            group.terminate();
            let _ = child.kill();
            let _ = child.wait();
            return if cancel.load(Ordering::Acquire) {
                Err(AppError::new(
                    "cancelled",
                    "Runtime installation was cancelled.",
                ))
            } else {
                Err(AppError::new(
                    "language_runtime_build",
                    format!("{label} did not finish within 30 minutes."),
                ))
            };
        }
        if let Some(status) = child.try_wait()? {
            group.terminate();
            if status.success() {
                return Ok(());
            }
            let detail = fs::read_to_string(log)
                .unwrap_or_default()
                .lines()
                .rev()
                .take(8)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join("\n");
            return Err(AppError::new(
                "language_runtime_build",
                format!(
                    "{label} failed. {}",
                    detail.chars().take(2000).collect::<String>()
                ),
            ));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// `source` is an already verified unpacked artifact. `staging` receives only
/// installed files; publication remains the installer's atomic responsibility.
pub(crate) fn build(
    id: &str,
    paths: BuildPaths<'_>,
    cancel: &AtomicBool,
    progress: &dyn Fn(&str),
) -> AppResult<()> {
    cancelled(cancel)?;
    let BuildPaths {
        source,
        staging,
        final_prefix,
        ..
    } = &paths;
    if !source.is_absolute()
        || !staging.is_absolute()
        || !final_prefix.is_absolute()
        || !source.is_dir()
    {
        return Err(AppError::new(
            "language_runtime_build",
            "Runtime recipes require absolute installer-owned directories.",
        ));
    }
    if staging.exists() && fs::read_dir(staging)?.next().is_some() {
        return Err(AppError::new(
            "language_runtime_build",
            "The runtime staging directory must be empty.",
        ));
    }
    let parent = staging.parent().ok_or_else(|| {
        AppError::new("language_runtime_build", "Missing runtime staging parent.")
    })?;
    fs::create_dir_all(parent)?;
    let temporary = tempfile::Builder::new()
        .prefix("runtime-build-")
        .tempdir_in(parent)?;
    let log = temporary.path().join("build.log");
    match id {
        "runtime-rust" => {
            let script = source.join("install.sh");
            if !script.is_file() {
                return Err(AppError::new(
                    "invalid_language_artifact",
                    "The official Rust installer is missing.",
                ));
            }
            progress("Installing the private Rust compiler and standard library");
            fs::create_dir_all(staging)?;
            run(
                Command::new("sh")
                    .arg(script)
                    .arg(format!("--prefix={}", staging.display()))
                    .arg("--disable-ldconfig")
                    .current_dir(source),
                cancel,
                &log,
                "Rust runtime installation",
            )?;
            if !staging.join("bin/rustc").is_file() || !staging.join("lib/rustlib").is_dir() {
                return Err(AppError::new(
                    "invalid_language_artifact",
                    "The private Rust toolchain is incomplete.",
                ));
            }
        }
        "runtime-ruby" | "runtime-yaml" | "runtime-openssl" => {
            build_source_runtime(id, &paths, temporary.path(), cancel, progress, &log)?
        }
        _ => {
            return Err(AppError::new(
                "invalid_language_artifact",
                "This runtime has no source installation recipe.",
            ));
        }
    }
    cancelled(cancel)
}

#[cfg(unix)]
fn build_source_runtime(
    id: &str,
    paths: &BuildPaths<'_>,
    temporary: &Path,
    cancel: &AtomicBool,
    progress: &dyn Fn(&str),
    log: &Path,
) -> AppResult<()> {
    preflight(id)?;
    let BuildPaths {
        source,
        staging,
        final_prefix,
        dependencies,
    } = paths;
    let build_dir = temporary.join("build");
    fs::create_dir_all(&build_dir)?;
    let mut command = Command::new(if id == "runtime-openssl" {
        "perl"
    } else {
        "sh"
    });
    let script = source.join(if id == "runtime-openssl" {
        "Configure"
    } else {
        "configure"
    });
    if !script.is_file() {
        return Err(AppError::new(
            "invalid_language_artifact",
            "The source archive has no configure script.",
        ));
    }
    command
        .arg(script)
        .arg(format!("--prefix={}", final_prefix.display()))
        .current_dir(&build_dir);
    match id {
        "runtime-ruby" => {
            command.args(["--disable-install-doc", "--disable-shared"]);
            for (dependency, option, header) in [
                ("runtime-openssl", "openssl", "include/openssl/ssl.h"),
                ("runtime-yaml", "libyaml", "include/yaml.h"),
            ] {
                let prefix = dependencies
                    .get(dependency)
                    .filter(|prefix| prefix.join(header).is_file())
                    .ok_or_else(|| {
                        AppError::new(
                            "missing_language_prerequisite",
                            format!("The private {dependency} dependency is unavailable."),
                        )
                    })?;
                command.arg(format!("--with-{option}-dir={}", prefix.display()));
            }
        }
        "runtime-yaml" => {
            command.args(["--disable-shared", "--with-pic"]);
        }
        "runtime-openssl" => {
            command
                .args(["no-shared", "no-tests", "--libdir=lib", "-fPIC"])
                .arg(format!("--openssldir={}/ssl", final_prefix.display()));
        }
        _ => unreachable!(),
    }
    progress(&format!("Configuring private {id}"));
    run(&mut command, cancel, log, &format!("{id} configuration"))?;
    progress(&format!("Compiling private {id}"));
    let jobs = std::thread::available_parallelism()
        .map_or(2, usize::from)
        .clamp(1, 4);
    run(
        Command::new("make")
            .arg(format!("-j{jobs}"))
            .current_dir(&build_dir),
        cancel,
        log,
        &format!("{id} compilation"),
    )?;
    progress(&format!("Staging private {id}"));
    let destination = temporary.join("dest");
    fs::create_dir_all(&destination)?;
    run(
        Command::new("make")
            .arg(if id == "runtime-openssl" {
                "install_sw"
            } else {
                "install"
            })
            .arg(format!("DESTDIR={}", destination.display()))
            .current_dir(&build_dir),
        cancel,
        log,
        &format!("{id} installation"),
    )?;
    let mut relative = PathBuf::new();
    for component in final_prefix.components() {
        match component {
            Component::RootDir => {}
            Component::Normal(name) => relative.push(name),
            _ => {
                return Err(AppError::new(
                    "language_runtime_build",
                    "The private installation prefix is invalid.",
                ));
            }
        }
    }
    let installed = destination.join(relative);
    let expected = match id {
        "runtime-ruby" => "bin/ruby",
        "runtime-yaml" => "lib/libyaml.a",
        "runtime-openssl" => "lib/libssl.a",
        _ => unreachable!(),
    };
    if !installed.join(expected).is_file() {
        return Err(AppError::new(
            "invalid_language_artifact",
            format!("The private {id} installation is incomplete."),
        ));
    }
    if staging.exists() {
        fs::remove_dir(staging)?;
    }
    fs::rename(installed, staging)?;
    Ok(())
}
#[cfg(not(unix))]
fn build_source_runtime(
    _id: &str,
    _paths: &BuildPaths<'_>,
    _temporary: &Path,
    _cancel: &AtomicBool,
    _progress: &dyn Fn(&str),
    _log: &Path,
) -> AppResult<()> {
    Err(AppError::new(
        "missing_language_prerequisite",
        "This platform requires a verified prebuilt runtime.",
    ))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn rust_installation_stays_in_staging_and_does_not_modify_sources() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        fs::create_dir(&source).unwrap();
        let script = "#!/bin/sh\nfor arg in \"$@\"; do case \"$arg\" in --prefix=*) prefix=${arg#--prefix=};; esac; done\nmkdir -p \"$prefix/bin\" \"$prefix/lib/rustlib\"\nprintf 'fixture' > \"$prefix/bin/rustc\"\n";
        fs::write(source.join("install.sh"), script).unwrap();
        let staging = root.path().join("stage");
        let destination = root.path().join("final");
        build(
            "runtime-rust",
            BuildPaths {
                source: &source,
                staging: &staging,
                final_prefix: &destination,
                dependencies: &BTreeMap::new(),
            },
            &AtomicBool::new(false),
            &|_| {},
        )
        .unwrap();
        assert!(staging.join("bin/rustc").is_file());
        assert!(!destination.exists());
        assert_eq!(
            fs::read_to_string(source.join("install.sh")).unwrap(),
            script
        );
    }
    #[test]
    fn cancellation_and_nonempty_staging_are_preserved() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        fs::create_dir(&source).unwrap();
        let staging = root.path().join("stage");
        fs::create_dir(&staging).unwrap();
        fs::write(staging.join("keep"), "keep").unwrap();
        assert_eq!(
            build(
                "runtime-ruby",
                BuildPaths {
                    source: &source,
                    staging: &staging,
                    final_prefix: &root.path().join("final"),
                    dependencies: &BTreeMap::new()
                },
                &AtomicBool::new(true),
                &|_| {}
            )
            .unwrap_err()
            .code,
            "cancelled"
        );
        assert!(
            build(
                "runtime-rust",
                BuildPaths {
                    source: &source,
                    staging: &staging,
                    final_prefix: &root.path().join("final"),
                    dependencies: &BTreeMap::new()
                },
                &AtomicBool::new(false),
                &|_| {}
            )
            .is_err()
        );
        assert_eq!(fs::read_to_string(staging.join("keep")).unwrap(), "keep");
    }
}
