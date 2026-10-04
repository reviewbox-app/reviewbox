use super::catalog::{self, Artifact, InstalledServer, ServerSpec};
use crate::{contracts::*, processes::ProcessGroup, storage::Storage};
use serde_json::Value;
use sha2::{Digest, Sha256, Sha512};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

struct Operation {
    progress: Mutex<LanguageServerInstallOperation>,
    cancelled: AtomicBool,
    publication: Mutex<()>,
    process: Mutex<Option<Arc<ProcessGroup>>>,
    sessions: Option<super::LanguageServers>,
    artifacts: BTreeMap<String, Artifact>,
    recipe_fingerprint: String,
}
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub(crate) struct InstallationRecipe {
    pub server: ServerSpec,
    pub artifacts: BTreeMap<String, Artifact>,
}
pub(crate) fn recipe(
    storage: &Storage,
    server: ServerSpec,
    custom_artifact: Option<Artifact>,
) -> AppResult<InstallationRecipe> {
    let mut artifacts = BTreeMap::new();
    let root = match server.method.as_str() {
        "npm" => Some("runtime-node"),
        "go" => Some("runtime-go"),
        "ruby" => Some("runtime-ruby"),
        "swift" | "external" => None,
        _ => Some(server.id.as_str()),
    };
    if let Some(id) = root {
        let mut pending = vec![
            custom_artifact
                .map(Ok)
                .unwrap_or_else(|| super::packs::artifact(storage, id))?,
        ];
        while let Some(artifact) = pending.pop() {
            if artifacts.contains_key(&artifact.id) {
                continue;
            }
            for dependency in &artifact.dependencies {
                pending.push(super::packs::artifact(storage, dependency)?);
            }
            artifacts.insert(artifact.id.clone(), artifact);
        }
    }
    Ok(InstallationRecipe { server, artifacts })
}
#[derive(Default)]
struct Owner {
    operations: Mutex<VecDeque<Arc<Operation>>>,
    install_gate: Mutex<()>,
    mutation_gate: Mutex<()>,
    stopping: AtomicBool,
    recovered: Mutex<BTreeSet<PathBuf>>,
    notify: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}
#[derive(Default, Clone)]
pub struct LanguageServerInstaller {
    owner: Arc<Owner>,
}

fn trim_history(records: &mut VecDeque<Arc<Operation>>) {
    while records.len() > 48 {
        let Some(index) = records.iter().position(|operation| {
            !matches!(
                operation
                    .progress
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .status
                    .as_str(),
                "queued" | "installing"
            )
        }) else {
            break;
        };
        records.remove(index);
    }
}

impl LanguageServerInstaller {
    pub fn set_notifier(&self, notify: impl Fn() + Send + Sync + 'static) {
        *self.owner.notify.lock().unwrap_or_else(|e| e.into_inner()) = Some(Arc::new(notify));
    }
    fn changed(&self) {
        notify(&self.owner);
    }
    pub(crate) fn recover(&self, storage: &Storage) -> AppResult<()> {
        let root = catalog::root(storage);
        let mut recovered = self
            .owner
            .recovered
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if recovered.contains(&root) {
            return Ok(());
        }
        let pending = root.join("pending");
        if pending.is_dir() {
            for entry in fs::read_dir(&pending)? {
                let entry = entry?;
                if !entry.file_type()?.is_file() {
                    continue;
                }
                if let Ok(mut progress) = serde_json::from_slice::<LanguageServerInstallOperation>(
                    &fs::read(entry.path())?,
                ) {
                    progress.status = "interrupted".into();
                    progress.phase = "interrupted".into();
                    progress.message =
                        "Installation stopped when ReviewBox closed. Retry explicitly to continue."
                            .into();
                    self.owner
                        .operations
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .push_back(Arc::new(Operation {
                            progress: Mutex::new(progress),
                            cancelled: AtomicBool::new(true),
                            publication: Mutex::new(()),
                            process: Mutex::new(None),
                            sessions: None,
                            artifacts: BTreeMap::new(),
                            recipe_fingerprint: String::new(),
                        }));
                }
                fs::remove_file(entry.path())?;
            }
        }
        let managed = root.join("managed");
        if managed.is_dir() {
            for server in fs::read_dir(managed)? {
                let server = server?;
                if !server.file_type()?.is_dir() {
                    continue;
                }
                for entry in fs::read_dir(server.path())? {
                    let entry = entry?;
                    if entry.file_type()?.is_dir()
                        && entry.file_name().to_string_lossy().starts_with(".install-")
                    {
                        fs::remove_dir_all(entry.path())?;
                    }
                }
            }
        }
        trim_history(
            &mut self
                .owner
                .operations
                .lock()
                .unwrap_or_else(|e| e.into_inner()),
        );
        recovered.insert(root);
        Ok(())
    }
    pub fn operations(&self) -> Vec<LanguageServerInstallOperation> {
        self.owner
            .operations
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|operation| {
                operation
                    .progress
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .clone()
            })
            .collect()
    }
    pub fn start(
        &self,
        storage: Storage,
        id: String,
        sessions: Option<super::LanguageServers>,
    ) -> AppResult<LanguageServerInstallOperation> {
        let server = super::packs::spec(&storage, &id)?;
        if let Some(reason) = &server.setup_required {
            return Err(AppError::new("language_server_setup_required", reason));
        }
        let recipe = recipe(&storage, server, None)?;
        self.start_recipe(storage, recipe, sessions)
    }
    pub(crate) fn start_recipe(
        &self,
        storage: Storage,
        recipe: InstallationRecipe,
        sessions: Option<super::LanguageServers>,
    ) -> AppResult<LanguageServerInstallOperation> {
        let _mutation = self
            .owner
            .mutation_gate
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        self.recover(&storage)?;
        let recipe_fingerprint = fingerprint(&serde_json::to_vec(&recipe)?);
        let server = recipe.server;
        let id = server.id.clone();
        if let Some(reason) = &server.setup_required {
            return Err(AppError::new("language_server_setup_required", reason));
        }
        if self.owner.stopping.load(Ordering::SeqCst) {
            return Err(AppError::new("shutting_down", "ReviewBox is closing."));
        }
        let mut records = self
            .owner
            .operations
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        for record in records.iter() {
            let value = record.progress.lock().unwrap_or_else(|e| e.into_inner());
            if value.server_id == id && matches!(value.status.as_str(), "queued" | "installing") {
                if record.recipe_fingerprint != recipe_fingerprint {
                    return Err(AppError::new(
                        "installation_busy",
                        "Another version is being installed. Wait for it to finish before applying this plan.",
                    ));
                }
                return Ok(value.clone());
            }
        }
        let progress = LanguageServerInstallOperation {
            id: uuid::Uuid::new_v4().to_string(),
            server_id: id,
            status: "queued".into(),
            phase: "waiting".into(),
            message: format!("Waiting to install {}", server.name),
            downloaded_bytes: 0,
            total_bytes: None,
        };
        let operation = Arc::new(Operation {
            progress: Mutex::new(progress.clone()),
            cancelled: AtomicBool::new(false),
            publication: Mutex::new(()),
            process: Mutex::new(None),
            sessions,
            artifacts: recipe.artifacts,
            recipe_fingerprint,
        });
        let pending = catalog::root(&storage).join("pending");
        fs::create_dir_all(&pending)?;
        let pending_path = pending.join(format!("{}.json", progress.id));
        fs::write(&pending_path, serde_json::to_vec(&progress)?)?;
        records.push_back(operation.clone());
        trim_history(&mut records);
        drop(records);
        let owner = self.owner.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _gate = owner.install_gate.lock().unwrap_or_else(|e| e.into_inner());
            let result =
                check(&operation).and_then(|()| install_server(&storage, &server, &operation));
            let succeeded = result.is_ok();
            let _ = fs::remove_file(pending_path);
            if let Some(group) = operation
                .process
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take()
            {
                group.terminate();
            }
            let mut progress = operation.progress.lock().unwrap_or_else(|e| e.into_inner());
            match result {
                Ok(()) => {
                    progress.status = "ready".into();
                    progress.phase = "ready".into();
                    progress.message = format!("{} is ready", server.name);
                }
                Err(error) => {
                    progress.status =
                        if matches!(error.code.as_str(), "installation_cancelled" | "cancelled") {
                            "cancelled"
                        } else {
                            "failed"
                        }
                        .into();
                    progress.phase = progress.status.clone();
                    progress.message = error.message;
                }
            }
            drop(progress);
            trim_history(&mut owner.operations.lock().unwrap_or_else(|e| e.into_inner()));
            if succeeded {
                notify(&owner);
            }
        });
        Ok(progress)
    }
    pub fn cancel(&self, id: &str) -> AppResult<()> {
        let record = self
            .owner
            .operations
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .find(|operation| {
                operation
                    .progress
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .id
                    == id
            })
            .cloned()
            .ok_or_else(|| AppError::new("not_found", "Installation was not found."))?;
        cancel(&record);
        Ok(())
    }
    pub fn shutdown(&self) {
        self.owner.stopping.store(true, Ordering::SeqCst);
        for record in self
            .owner
            .operations
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
        {
            cancel(record);
        }
    }
    fn check_idle(&self, id: &str) -> AppResult<()> {
        if self.operations().iter().any(|operation| {
            operation.server_id == id
                && matches!(operation.status.as_str(), "queued" | "installing")
        }) {
            return Err(AppError::new(
                "installation_busy",
                "Cancel the current installation before changing this server.",
            ));
        }
        Ok(())
    }
    pub fn set_enabled(&self, storage: &Storage, id: &str, enabled: bool) -> AppResult<()> {
        let _mutation = self
            .owner
            .mutation_gate
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        super::packs::spec(storage, id)?;
        self.check_idle(id)?;
        let mut receipt = catalog::installed(storage, id)?
            .ok_or_else(|| AppError::new("not_installed", "Install this server first."))?;
        receipt.enabled = enabled;
        catalog::save_installed(storage, id, &receipt)?;
        self.changed();
        Ok(())
    }
    pub fn uninstall(&self, storage: &Storage, id: &str) -> AppResult<()> {
        let _mutation = self
            .owner
            .mutation_gate
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        super::packs::spec(storage, id)?;
        self.check_idle(id)?;
        let receipt = catalog::installed(storage, id)?
            .ok_or_else(|| AppError::new("not_installed", "This server is not installed."))?;
        // Remove the active receipt first. A failed cleanup cannot leave a stale runnable entry.
        fs::remove_file(
            catalog::root(storage)
                .join("state")
                .join(format!("{id}.json")),
        )?;
        if let Some(directory) = receipt.directory {
            let owned = catalog::root(storage).join("managed").join(id);
            if !directory.starts_with(&owned) {
                return Err(AppError::new(
                    "invalid_installation",
                    "Refusing to delete a directory outside managed language servers.",
                ));
            }
            if owned.exists() {
                fs::remove_dir_all(owned)?;
            }
        }
        self.changed();
        Ok(())
    }
}

fn notify(owner: &Owner) {
    let callback = owner
        .notify
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    if let Some(callback) = callback {
        callback();
    }
}

fn cancel(operation: &Operation) {
    let _publication = operation
        .publication
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let mut progress = operation.progress.lock().unwrap_or_else(|e| e.into_inner());
    if !matches!(progress.status.as_str(), "queued" | "installing") {
        return;
    }
    operation.cancelled.store(true, Ordering::SeqCst);
    progress.status = "cancelled".into();
    progress.phase = "cancelled".into();
    progress.message = "Installation cancelled".into();
    if let Some(group) = operation
        .process
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
    {
        group.terminate();
    }
}
fn check(operation: &Operation) -> AppResult<()> {
    if operation.cancelled.load(Ordering::SeqCst) {
        Err(AppError::new(
            "installation_cancelled",
            "Installation cancelled. The previous version remains available.",
        ))
    } else {
        Ok(())
    }
}
fn progress(operation: &Operation, phase: &str, message: impl Into<String>) -> AppResult<()> {
    check(operation)?;
    let mut current = operation.progress.lock().unwrap_or_else(|e| e.into_inner());
    check(operation)?;
    current.status = "installing".into();
    current.phase = phase.into();
    current.message = message.into();
    current.downloaded_bytes = 0;
    current.total_bytes = None;
    Ok(())
}

fn client() -> AppResult<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .user_agent("ReviewBox-language-installer/1")
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|error| AppError::new("download", error.to_string()))
}
fn download(artifact: &Artifact, destination: &Path, operation: &Operation) -> AppResult<()> {
    if !artifact.url.starts_with("https://") {
        return Err(AppError::new(
            "untrusted_download",
            "Language downloads must use HTTPS.",
        ));
    }
    if !artifact
        .sha256
        .as_ref()
        .is_some_and(|hash| hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
        && !artifact.sha512.as_ref().is_some_and(|hash| {
            hash.len() == 128 && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
    {
        return Err(AppError::new(
            "missing_checksum",
            "The bundled download has no valid checksum.",
        ));
    }
    progress(
        operation,
        "downloading",
        format!("Downloading {} {}", artifact.id, artifact.version),
    )?;
    let mut response = client()?
        .get(&artifact.url)
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|error| {
            AppError::new(
                "download",
                format!("Cannot download {}: {error}", artifact.id),
            )
        })?;
    operation
        .progress
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .total_bytes = response.content_length();
    let mut output = fs::File::create(destination)?;
    let mut sha256 = Sha256::new();
    let mut sha512 = Sha512::new();
    let mut buffer = vec![0; 128 * 1024];
    let mut size = 0;
    loop {
        check(operation)?;
        let length = response.read(&mut buffer)?;
        if length == 0 {
            break;
        }
        size += length as u64;
        if size > 3 * 1024 * 1024 * 1024 {
            return Err(AppError::new(
                "download_too_large",
                "Language toolchain archive exceeds 3 GiB.",
            ));
        }
        output.write_all(&buffer[..length])?;
        sha256.update(&buffer[..length]);
        sha512.update(&buffer[..length]);
        operation
            .progress
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .downloaded_bytes = size;
    }
    output.sync_all()?;
    let actual256: String = sha256
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let actual512: String = sha512
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    verify_checksum(artifact, &actual256, &actual512)?;
    check(operation)
}

fn verify_checksum(artifact: &Artifact, actual256: &str, actual512: &str) -> AppResult<()> {
    if artifact
        .sha256
        .as_ref()
        .is_some_and(|hash| !hash.eq_ignore_ascii_case(actual256))
        || artifact
            .sha512
            .as_ref()
            .is_some_and(|hash| !hash.eq_ignore_ascii_case(actual512))
    {
        return Err(AppError::new(
            "checksum_mismatch",
            format!(
                "{} failed its download checksum. Nothing was installed.",
                artifact.id
            ),
        ));
    }
    Ok(())
}

fn safe_relative(path: &Path) -> AppResult<()> {
    if path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
    {
        return Err(AppError::new(
            "unsafe_archive",
            "An archive entry escapes its installation directory.",
        ));
    }
    Ok(())
}
fn unpack(
    artifact: &Artifact,
    archive: &Path,
    target: &Path,
    operation: &Operation,
) -> AppResult<()> {
    progress(
        operation,
        "extracting",
        format!("Unpacking {}", artifact.id),
    )?;
    fs::create_dir_all(target)?;
    let expanded = target.join(".archive");
    fs::create_dir_all(&expanded)?;
    match artifact.format.as_str() {
        "tar.gz" => {
            let reader = flate2::read::GzDecoder::new(fs::File::open(archive)?);
            let mut archive = tar::Archive::new(reader);
            let mut total = 0u64;
            for entry in archive.entries()? {
                check(operation)?;
                let mut entry = entry?;
                safe_relative(&entry.path()?)?;
                total += entry.size();
                if total > 8 * 1024 * 1024 * 1024 {
                    return Err(AppError::new(
                        "archive_too_large",
                        "The extracted toolchain exceeds 8 GiB.",
                    ));
                }
                if !entry.unpack_in(&expanded)? {
                    return Err(AppError::new(
                        "unsafe_archive",
                        "An archive entry could not be safely extracted.",
                    ));
                }
            }
        }
        "zip" => {
            let mut archive = zip::ZipArchive::new(fs::File::open(archive)?)
                .map_err(|error| AppError::new("archive", error.to_string()))?;
            let mut total = 0u64;
            for index in 0..archive.len() {
                check(operation)?;
                let mut entry = archive
                    .by_index(index)
                    .map_err(|error| AppError::new("archive", error.to_string()))?;
                let relative = entry.enclosed_name().ok_or_else(|| {
                    AppError::new(
                        "unsafe_archive",
                        "An archive entry escapes its installation directory.",
                    )
                })?;
                safe_relative(&relative)?;
                let output = expanded.join(relative);
                if entry.is_dir() {
                    fs::create_dir_all(&output)?;
                    continue;
                }
                if let Some(parent) = output.parent() {
                    fs::create_dir_all(parent)?;
                }
                total += entry.size();
                if total > 8 * 1024 * 1024 * 1024 {
                    return Err(AppError::new(
                        "archive_too_large",
                        "The extracted toolchain exceeds 8 GiB.",
                    ));
                }
                if entry
                    .unix_mode()
                    .is_some_and(|mode| mode & 0o170000 == 0o120000)
                {
                    let mut link = String::new();
                    entry.by_ref().take(4097).read_to_string(&mut link)?;
                    if link.len() > 4096 {
                        return Err(AppError::new(
                            "unsafe_archive",
                            "An archive symlink target is too long.",
                        ));
                    }
                    safe_link(&expanded, &output, &link)?;
                    #[cfg(unix)]
                    std::os::unix::fs::symlink(link, &output)?;
                    #[cfg(not(unix))]
                    return Err(AppError::new(
                        "unsupported_archive",
                        "This platform cannot install Unix toolchain links.",
                    ));
                } else {
                    let mut file = fs::File::create(&output)?;
                    std::io::copy(&mut entry, &mut file)?;
                    #[cfg(unix)]
                    if let Some(mode) = entry.unix_mode() {
                        use std::os::unix::fs::PermissionsExt;
                        fs::set_permissions(output, fs::Permissions::from_mode(mode & 0o777))?;
                    }
                }
            }
        }
        "gz" | "file" => {
            safe_relative(Path::new(&artifact.executable))?;
            let output = expanded.join(&artifact.executable);
            if let Some(parent) = output.parent() {
                fs::create_dir_all(parent)?;
            }
            if artifact.format == "gz" {
                let mut input = flate2::read::GzDecoder::new(fs::File::open(archive)?)
                    .take(8 * 1024 * 1024 * 1024 + 1);
                if std::io::copy(&mut input, &mut fs::File::create(output)?)?
                    > 8 * 1024 * 1024 * 1024
                {
                    return Err(AppError::new(
                        "archive_too_large",
                        "The extracted toolchain exceeds 8 GiB.",
                    ));
                }
            } else {
                fs::copy(archive, output)?;
            }
        }
        _ => {
            return Err(AppError::new(
                "unsupported_archive",
                "This archive format is unsupported.",
            ));
        }
    }
    let mut source = expanded.clone();
    for _ in 0..artifact.strip_components {
        let children = fs::read_dir(&source)?.collect::<Result<Vec<_>, _>>()?;
        if children.len() != 1 || !children[0].file_type()?.is_dir() {
            return Err(AppError::new(
                "archive_layout",
                "The toolchain archive layout changed.",
            ));
        }
        source = children[0].path();
    }
    for entry in fs::read_dir(&source)? {
        let entry = entry?;
        fs::rename(entry.path(), target.join(entry.file_name()))?;
    }
    fs::remove_dir_all(expanded)?;
    check(operation)
}
fn safe_link(root: &Path, output: &Path, link: &str) -> AppResult<()> {
    let mut depth = output
        .parent()
        .and_then(|path| path.strip_prefix(root).ok())
        .map_or(0, |path| path.components().count());
    for component in Path::new(link).components() {
        match component {
            Component::Normal(_) => depth += 1,
            Component::CurDir => {}
            Component::ParentDir if depth > 0 => depth -= 1,
            _ => {
                return Err(AppError::new(
                    "unsafe_archive",
                    "An archive symlink escapes its installation directory.",
                ));
            }
        }
    }
    Ok(())
}

fn execute(
    executable: &Path,
    arguments: &[String],
    cwd: &Path,
    environment: &BTreeMap<String, String>,
    operation: &Operation,
) -> AppResult<String> {
    check(operation)?;
    let log = tempfile::NamedTempFile::new_in(cwd)?;
    let mut command = Command::new(executable);
    let log_file = log.reopen()?;
    command
        .args(arguments)
        .current_dir(cwd)
        .envs(environment)
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .stdin(Stdio::null())
        .stdout(log_file.try_clone()?)
        .stderr(log_file);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|error| {
        AppError::new(
            "installation_process",
            format!("Cannot run {}: {error}", executable.display()),
        )
    })?;
    let group = Arc::new(ProcessGroup::new(child.id()));
    *operation.process.lock().unwrap_or_else(|e| e.into_inner()) = Some(group.clone());
    let deadline = Instant::now() + Duration::from_secs(30 * 60);
    let status = loop {
        if check(operation).is_err() || Instant::now() > deadline {
            group.terminate();
            let _ = child.wait();
            *operation.process.lock().unwrap_or_else(|e| e.into_inner()) = None;
            check(operation)?;
            return Err(AppError::new(
                "installation_timeout",
                "Installation did not finish within 30 minutes.",
            ));
        }
        if let Some(status) = child.try_wait()? {
            break status;
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    group.terminate();
    *operation.process.lock().unwrap_or_else(|e| e.into_inner()) = None;
    let mut output = String::new();
    log.reopen()?.take(16 * 1024).read_to_string(&mut output)?;
    if !status.success() {
        return Err(AppError::new(
            "installation_process",
            format!("Installation failed: {}", output.trim()),
        ));
    }
    check(operation)?;
    Ok(output)
}

fn private_environment(
    storage: &Storage,
    dependencies: &BTreeMap<String, InstalledServer>,
) -> BTreeMap<String, String> {
    let mut environment = BTreeMap::new();
    let mut binaries = Vec::new();
    for (id, dependency) in dependencies {
        environment.extend(dependency.environment.clone());
        let executable = Path::new(&dependency.executable);
        if let Some(parent) = executable
            .parent()
            .filter(|_| !matches!(id.as_str(), "runtime-yaml" | "runtime-rust-src"))
        {
            binaries.push(parent.to_path_buf());
        }
        match id.as_str() {
            "runtime-rust-src" => {
                if let Some(root) = &dependency.directory {
                    environment.insert(
                        "RUST_SRC_PATH".into(),
                        root.join("rust-src/lib/rustlib/src/rust/library")
                            .to_string_lossy()
                            .into(),
                    );
                }
            }
            "runtime-java" => {
                if let Some(home) = executable.parent().and_then(Path::parent) {
                    environment.insert("JAVA_HOME".into(), home.to_string_lossy().into());
                }
            }
            "runtime-dotnet" => {
                if let Some(home) = executable.parent() {
                    environment.insert("DOTNET_ROOT".into(), home.to_string_lossy().into());
                    environment.insert(
                        "DOTNET_CLI_HOME".into(),
                        catalog::root(storage)
                            .join("dotnet-home")
                            .to_string_lossy()
                            .into(),
                    );
                    environment.insert("DOTNET_CLI_TELEMETRY_OPTOUT".into(), "1".into());
                }
            }
            "runtime-go" => {
                if let Some(home) = executable.parent().and_then(Path::parent) {
                    environment.insert("GOROOT".into(), home.to_string_lossy().into());
                }
                environment.insert(
                    "GOPATH".into(),
                    catalog::root(storage)
                        .join("go-work")
                        .to_string_lossy()
                        .into(),
                );
                environment.insert(
                    "GOCACHE".into(),
                    catalog::root(storage)
                        .join("go-cache")
                        .to_string_lossy()
                        .into(),
                );
            }
            _ => {}
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        binaries.extend(std::env::split_paths(&path));
    }
    if let Ok(path) = std::env::join_paths(binaries) {
        environment.insert("PATH".into(), path.to_string_lossy().into());
    }
    environment
}
fn expand(
    value: &str,
    root: &Path,
    dependencies: &BTreeMap<String, InstalledServer>,
) -> AppResult<String> {
    let mut result = value.replace("{root}", &root.to_string_lossy());
    for (id, dependency) in dependencies {
        if let Some(path) = &dependency.directory {
            result = result.replace(&format!("{{dependency:{id}}}"), &path.to_string_lossy());
        }
    }
    if result.contains("{dependency:") {
        return Err(AppError::new(
            "missing_runtime",
            "A required private runtime is unavailable.",
        ));
    }
    Ok(result)
}

fn install_artifact(
    storage: &Storage,
    id: &str,
    operation: &Operation,
    ancestry: &mut Vec<String>,
) -> AppResult<InstalledServer> {
    if ancestry.iter().any(|ancestor| ancestor == id) {
        return Err(AppError::new(
            "invalid_catalogue",
            "Circular language runtime dependency.",
        ));
    }
    let artifact = operation.artifacts.get(id).ok_or_else(|| {
        AppError::new(
            "invalid_recipe",
            "An artifact is missing from the approved installation recipe.",
        )
    })?;
    if !catalog::valid_id(&artifact.version) {
        return Err(AppError::new(
            "invalid_catalogue",
            "Invalid toolchain version.",
        ));
    }
    if artifact.recipe.is_some() {
        progress(
            operation,
            "checking",
            format!("Checking prerequisites for {id}"),
        )?;
        super::runtime_builds::preflight(id)?;
    }
    ancestry.push(id.into());
    let mut dependencies = BTreeMap::new();
    for dependency in &artifact.dependencies {
        dependencies.insert(
            dependency.clone(),
            install_artifact(storage, dependency, operation, ancestry)?,
        );
    }
    ancestry.pop();
    if let Some(installed) = catalog::installed(storage, id)?
        && let Some(directory) = &installed.directory
    {
        let expected_executable = if artifact.executable.starts_with('{') {
            expand(&artifact.executable, directory, &dependencies)?
        } else {
            directory
                .join(&artifact.executable)
                .to_string_lossy()
                .into_owned()
        };
        let expected_arguments = artifact
            .arguments
            .iter()
            .map(|value| expand(value, directory, &dependencies))
            .collect::<AppResult<Vec<_>>>()?;
        let expected_environment = private_environment(storage, &dependencies);
        if installed.version == artifact.version
            && installed.executable == expected_executable
            && installed.arguments == expected_arguments
            && expected_environment
                .iter()
                .all(|(key, value)| installed.environment.get(key) == Some(value))
            && Path::new(&installed.executable).is_file()
        {
            return Ok(installed);
        }
    }
    let parent = catalog::root(storage).join("managed").join(id);
    fs::create_dir_all(&parent)?;
    let staging = tempfile::Builder::new()
        .prefix(".install-")
        .tempdir_in(&parent)?;
    let payload = staging.path().join("payload");
    fs::create_dir_all(&payload)?;
    let archive = staging.path().join("archive");
    download(artifact, &archive, operation)?;
    unpack(artifact, &archive, &payload, operation)?;
    let final_path = parent.join(format!("{}-{}", artifact.version, uuid::Uuid::new_v4()));
    let mut environment = private_environment(storage, &dependencies);
    if id == "kotlin" {
        environment.insert("IJ_JAVA_OPTIONS".into(), "-Didea.suppress.statistics.report=true -Didea.disable.collect.statistics=true -Didea.headless.enable.statistics=false".into());
    }
    if artifact.recipe.is_some() {
        let built = staging.path().join("built");
        let dependency_paths = dependencies
            .iter()
            .filter_map(|(id, receipt)| receipt.directory.clone().map(|path| (id.clone(), path)))
            .collect();
        super::runtime_builds::build(
            id,
            super::runtime_builds::BuildPaths {
                source: &payload,
                staging: &built,
                final_prefix: &final_path,
                dependencies: &dependency_paths,
            },
            &operation.cancelled,
            &|message| {
                let _ = progress(operation, "building", message);
            },
        )?;
        fs::remove_dir_all(&payload)?;
        fs::rename(built, &payload)?;
    }
    let executable = if artifact.executable.starts_with('{') {
        expand(&artifact.executable, &final_path, &dependencies)?
    } else {
        safe_relative(Path::new(&artifact.executable))?;
        final_path
            .join(&artifact.executable)
            .to_string_lossy()
            .into()
    };
    let staged_executable = if artifact.executable.starts_with('{') {
        PathBuf::from(expand(&artifact.executable, &payload, &dependencies)?)
    } else {
        payload.join(&artifact.executable)
    };
    if !staged_executable.is_file() {
        return Err(AppError::new(
            "missing_executable",
            format!("{} archive has no expected executable.", artifact.id),
        ));
    }
    #[cfg(unix)]
    if staged_executable.starts_with(&payload) && !matches!(id, "runtime-yaml" | "runtime-rust-src")
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&staged_executable, fs::Permissions::from_mode(0o755))?;
    }
    let arguments = artifact
        .arguments
        .iter()
        .map(|argument| expand(argument, &final_path, &dependencies))
        .collect::<AppResult<Vec<_>>>()?;
    let receipt = InstalledServer {
        version: artifact.version.clone(),
        enabled: true,
        executable,
        arguments,
        environment,
        directory: Some(final_path.clone()),
    };
    publish(storage, id, &payload, &final_path, &receipt, operation)?;
    Ok(receipt)
}

fn publish(
    storage: &Storage,
    id: &str,
    payload: &Path,
    final_path: &Path,
    receipt: &InstalledServer,
    operation: &Operation,
) -> AppResult<()> {
    progress(operation, "publishing", format!("Activating {id}"))?;
    let _guard = operation
        .publication
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    check(operation)?;
    if operation
        .progress
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .server_id
        == id
        && let Some(sessions) = &operation.sessions
    {
        sessions.stop_server(id);
    }
    fs::rename(payload, final_path)?;
    if id == "runtime-ruby"
        && let Err(error) = execute(
            Path::new(&receipt.executable),
            &[
                "-ropenssl".into(),
                "-rpsych".into(),
                "-e".into(),
                "puts RUBY_VERSION".into(),
            ],
            final_path,
            &receipt.environment,
            operation,
        )
    {
        let _ = fs::remove_dir_all(final_path);
        return Err(error);
    }
    if let Err(error) = catalog::save_installed(storage, id, receipt) {
        let _ = fs::remove_dir_all(final_path);
        return Err(error);
    }
    let mut state = operation.progress.lock().unwrap_or_else(|e| e.into_inner());
    if state.server_id == id {
        state.status = "ready".into();
    }
    Ok(())
}

fn install_server(storage: &Storage, server: &ServerSpec, operation: &Operation) -> AppResult<()> {
    match server.method.as_str() {
        "external" => {
            let receipt = InstalledServer {
                version: server.version.clone(),
                enabled: true,
                executable: server.package.clone(),
                arguments: server.arguments.clone(),
                environment: BTreeMap::new(),
                directory: None,
            };
            check(operation)?;
            catalog::save_installed(storage, &server.id, &receipt)
        }
        "npm" => install_npm(storage, server, operation),
        "go" => install_go(storage, server, operation),
        "ruby" => install_ruby(storage, server, operation),
        "swift" => {
            progress(
                operation,
                "detecting",
                "Locating the installed Swift toolchain",
            )?;
            let scratch = tempfile::tempdir()?;
            let output = execute(
                Path::new("/usr/bin/xcrun"),
                &["--find".into(), "sourcekit-lsp".into()],
                scratch.path(),
                &BTreeMap::new(),
                operation,
            )?;
            let executable = output.trim().to_string();
            if !Path::new(&executable).is_file() {
                return Err(AppError::new(
                    "missing_toolchain",
                    "Install Xcode or a Swift toolchain before enabling SourceKit-LSP.",
                ));
            }
            let version = execute(
                Path::new("/usr/bin/xcrun"),
                &["swift".into(), "--version".into()],
                scratch.path(),
                &BTreeMap::new(),
                operation,
            )?
            .lines()
            .next()
            .unwrap_or("Installed Swift toolchain")
            .trim()
            .to_string();
            let receipt = InstalledServer {
                version,
                enabled: true,
                executable,
                arguments: vec![],
                environment: BTreeMap::new(),
                directory: None,
            };
            let _guard = operation
                .publication
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            check(operation)?;
            if let Some(sessions) = &operation.sessions {
                sessions.stop_server(&server.id);
            }
            catalog::save_installed(storage, &server.id, &receipt)
        }
        _ => {
            install_artifact(storage, &server.id, operation, &mut Vec::new())?;
            Ok(())
        }
    }
}

fn install_npm(storage: &Storage, server: &ServerSpec, operation: &Operation) -> AppResult<()> {
    let node = install_artifact(storage, "runtime-node", operation, &mut Vec::new())?;
    let node_root = node
        .directory
        .as_ref()
        .ok_or_else(|| AppError::new("missing_runtime", "Private Node runtime is unavailable."))?;
    let npm = node_root.join("lib/node_modules/npm/bin/npm-cli.js");
    if !npm.is_file() {
        return Err(AppError::new(
            "missing_runtime",
            "The private Node distribution does not include npm.",
        ));
    }
    let locks: BTreeMap<String, Value> =
        serde_json::from_str(include_str!("../../../resources/languages/npm-locks.json"))?;
    let lock = locks.get(&server.id);
    let parent = catalog::root(storage).join("managed").join(&server.id);
    fs::create_dir_all(&parent)?;
    let staging = tempfile::Builder::new()
        .prefix(".install-")
        .tempdir_in(&parent)?;
    let payload = staging.path().join("payload");
    fs::create_dir_all(&payload)?;
    if let Some(lock) = lock {
        fs::write(payload.join("package-lock.json"), serde_json::to_vec(lock)?)?;
    }
    fs::write(
        payload.join("package.json"),
        serde_json::to_vec(
            &serde_json::json!({"name":format!("reviewbox-lsp-{}", server.id),"version":"1.0.0","private":true,"dependencies":server.packages,"overrides":server.overrides}),
        )?,
    )?;
    let userconfig = staging.path().join("user.npmrc");
    let globalconfig = staging.path().join("global.npmrc");
    fs::write(&userconfig, "")?;
    fs::write(&globalconfig, "")?;
    let dependencies = BTreeMap::from([("runtime-node".into(), node.clone())]);
    let environment = private_environment(storage, &dependencies);
    progress(
        operation,
        "installing",
        format!("Installing {} from verified package locks", server.name),
    )?;
    let arguments = vec![
        npm.to_string_lossy().into(),
        if lock.is_some() {
            "ci".into()
        } else {
            "install".into()
        },
        "--ignore-scripts".into(),
        "--omit=dev".into(),
        "--no-audit".into(),
        "--no-fund".into(),
        "--registry=https://registry.npmjs.org".into(),
        format!("--userconfig={}", userconfig.display()),
        format!("--globalconfig={}", globalconfig.display()),
        format!(
            "--cache={}",
            catalog::root(storage).join("npm-cache").display()
        ),
    ];
    execute(
        Path::new(&node.executable),
        &arguments,
        &payload,
        &environment,
        operation,
    )?;
    let package_root = payload.join("node_modules").join(&server.package);
    let package: Value = serde_json::from_slice(&fs::read(package_root.join("package.json"))?)?;
    let binary = package["bin"]
        .as_str()
        .or_else(|| package["bin"][&server.bin].as_str())
        .ok_or_else(|| {
            AppError::new(
                "missing_executable",
                "The locked package has no expected language server executable.",
            )
        })?;
    safe_relative(Path::new(binary))?;
    if !package_root.join(binary).is_file() || package["version"].as_str() != Some(&server.version)
    {
        return Err(AppError::new(
            "invalid_package",
            "The installed package does not match the pinned server version.",
        ));
    }
    let final_path = parent.join(format!("{}-{}", server.version, uuid::Uuid::new_v4()));
    let mut arguments = vec![
        final_path
            .join("node_modules")
            .join(&server.package)
            .join(binary)
            .to_string_lossy()
            .into(),
    ];
    arguments.extend(server.arguments.clone());
    let receipt = InstalledServer {
        version: server.version.clone(),
        enabled: true,
        executable: node.executable,
        arguments,
        environment,
        directory: Some(final_path.clone()),
    };
    publish(
        storage,
        &server.id,
        &payload,
        &final_path,
        &receipt,
        operation,
    )
}

fn install_go(storage: &Storage, server: &ServerSpec, operation: &Operation) -> AppResult<()> {
    let runtime = install_artifact(storage, "runtime-go", operation, &mut Vec::new())?;
    let parent = catalog::root(storage).join("managed").join(&server.id);
    fs::create_dir_all(&parent)?;
    let staging = tempfile::Builder::new()
        .prefix(".install-")
        .tempdir_in(&parent)?;
    let payload = staging.path().join("payload");
    fs::create_dir_all(payload.join("bin"))?;
    let dependencies = BTreeMap::from([("runtime-go".into(), runtime.clone())]);
    let mut environment = private_environment(storage, &dependencies);
    environment.insert("GOBIN".into(), payload.join("bin").to_string_lossy().into());
    environment.insert("GOTOOLCHAIN".into(), "local".into());
    environment.insert("GOSUMDB".into(), "sum.golang.org".into());
    environment.insert("GOPROXY".into(), "https://proxy.golang.org".into());
    environment.insert("GONOSUMDB".into(), String::new());
    environment.insert("GOPRIVATE".into(), String::new());
    environment.insert("GOENV".into(), "off".into());
    environment.insert("GOFLAGS".into(), String::new());
    let module = if server.package.is_empty() {
        "golang.org/x/tools/gopls"
    } else {
        &server.package
    };
    let binary = if server.bin.is_empty() {
        "gopls"
    } else {
        &server.bin
    };
    progress(
        operation,
        "building",
        format!("Building pinned {} with private Go", server.name),
    )?;
    execute(
        Path::new(&runtime.executable),
        &["install".into(), format!("{module}@v{}", server.version)],
        &payload,
        &environment,
        operation,
    )?;
    if !payload.join("bin").join(binary).is_file() {
        return Err(AppError::new(
            "missing_executable",
            "The Go language server build produced no executable.",
        ));
    }
    environment.remove("GOBIN");
    let final_path = parent.join(format!("{}-{}", server.version, uuid::Uuid::new_v4()));
    let receipt = InstalledServer {
        version: server.version.clone(),
        enabled: true,
        executable: final_path.join("bin").join(binary).to_string_lossy().into(),
        arguments: vec![],
        environment,
        directory: Some(final_path.clone()),
    };
    publish(
        storage,
        &server.id,
        &payload,
        &final_path,
        &receipt,
        operation,
    )
}

fn install_ruby(storage: &Storage, server: &ServerSpec, operation: &Operation) -> AppResult<()> {
    let runtime = install_artifact(storage, "runtime-ruby", operation, &mut Vec::new())?;
    let runtime_root = runtime
        .directory
        .as_ref()
        .ok_or_else(|| AppError::new("missing_runtime", "Private Ruby is unavailable."))?;
    let parent = catalog::root(storage).join("managed").join(&server.id);
    fs::create_dir_all(&parent)?;
    let staging = tempfile::Builder::new()
        .prefix(".install-")
        .tempdir_in(&parent)?;
    let payload = staging.path().join("payload");
    fs::create_dir_all(payload.join("bin"))?;
    // The server must not compose or install the captured project's Gemfile on startup.
    fs::write(
        payload.join("Gemfile"),
        format!(
            "source 'https://rubygems.org'\ngem 'ruby-lsp', '= {}'\n",
            server.version
        ),
    )?;
    let gems: Vec<Value> =
        serde_json::from_str(include_str!("../../../resources/languages/ruby-gems.json"))?;
    let mut archives = Vec::new();
    for gem in gems {
        let name = gem["name"].as_str().unwrap_or_default();
        let version = gem["version"].as_str().unwrap_or_default();
        if !catalog::valid_id(name) || !catalog::valid_id(version) {
            return Err(AppError::new(
                "invalid_catalogue",
                "Invalid pinned gem metadata.",
            ));
        }
        let archive = staging.path().join(format!("{name}-{version}.gem"));
        let artifact = Artifact {
            id: name.into(),
            version: version.into(),
            platform: catalog::platform(),
            url: gem["url"].as_str().unwrap_or_default().into(),
            sha256: gem["sha256"].as_str().map(String::from),
            sha512: None,
            format: "file".into(),
            executable: String::new(),
            arguments: vec![],
            strip_components: 0,
            dependencies: vec![],
            recipe: None,
        };
        download(&artifact, &archive, operation)?;
        archives.push(archive.to_string_lossy().into_owned());
    }
    let dependencies = BTreeMap::from([("runtime-ruby".into(), runtime.clone())]);
    let mut environment = private_environment(storage, &dependencies);
    environment.insert(
        "GEM_HOME".into(),
        payload.join("gems").to_string_lossy().into(),
    );
    environment.insert(
        "GEM_PATH".into(),
        payload.join("gems").to_string_lossy().into(),
    );
    progress(
        operation,
        "installing",
        "Installing verified Ruby LSP gems privately",
    )?;
    let mut arguments = vec![
        runtime_root.join("bin/gem").to_string_lossy().into(),
        "install".into(),
        "--local".into(),
        "--ignore-dependencies".into(),
        "--no-document".into(),
        "--install-dir".into(),
        payload.join("gems").to_string_lossy().into(),
        "--bindir".into(),
        payload.join("bin").to_string_lossy().into(),
    ];
    arguments.extend(archives);
    execute(
        Path::new(&runtime.executable),
        &arguments,
        &payload,
        &environment,
        operation,
    )?;
    if !payload.join("bin/ruby-lsp").is_file() {
        return Err(AppError::new(
            "missing_executable",
            "The Ruby LSP installation produced no executable.",
        ));
    }
    let final_path = parent.join(format!("{}-{}", server.version, uuid::Uuid::new_v4()));
    environment.insert(
        "GEM_HOME".into(),
        final_path.join("gems").to_string_lossy().into(),
    );
    environment.insert(
        "GEM_PATH".into(),
        final_path.join("gems").to_string_lossy().into(),
    );
    environment.insert(
        "BUNDLE_GEMFILE".into(),
        final_path.join("Gemfile").to_string_lossy().into(),
    );
    let receipt = InstalledServer {
        version: server.version.clone(),
        enabled: true,
        executable: runtime.executable,
        arguments: vec![final_path.join("bin/ruby-lsp").to_string_lossy().into()],
        environment,
        directory: Some(final_path.clone()),
    };
    publish(
        storage,
        &server.id,
        &payload,
        &final_path,
        &receipt,
        operation,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn operation(id: &str, status: &str) -> Arc<Operation> {
        Arc::new(Operation {
            progress: Mutex::new(LanguageServerInstallOperation {
                id: uuid::Uuid::new_v4().to_string(),
                server_id: id.into(),
                status: status.into(),
                phase: status.into(),
                message: String::new(),
                downloaded_bytes: 0,
                total_bytes: None,
            }),
            cancelled: AtomicBool::new(false),
            publication: Mutex::new(()),
            process: Mutex::new(None),
            sessions: None,
            artifacts: BTreeMap::new(),
            recipe_fingerprint: String::new(),
        })
    }
    #[test]
    fn active_operations_are_never_evicted_from_cancellation_history() {
        let mut operations = VecDeque::new();
        operations.push_back(operation("old", "failed"));
        for _ in 0..60 {
            operations.push_back(operation("queued", "queued"));
        }
        trim_history(&mut operations);
        assert_eq!(operations.len(), 60);
        assert!(
            operations
                .iter()
                .all(|item| item.progress.lock().unwrap().status == "queued")
        );
        for item in &operations {
            cancel(item);
        }
        trim_history(&mut operations);
        assert_eq!(operations.len(), 48);
        assert!(
            operations
                .iter()
                .all(|item| item.cancelled.load(Ordering::SeqCst))
        );
    }
    #[test]
    fn corrupt_downloads_fail_sha256_and_sha512_verification() {
        let artifacts: Vec<Artifact> = serde_json::from_str(include_str!(
            "../../../resources/languages/native-artifacts.json"
        ))
        .unwrap();
        let mut artifact = artifacts
            .into_iter()
            .find(|artifact| artifact.id == "runtime-node")
            .unwrap();
        let hex = |bytes: &[u8]| {
            bytes
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        };
        let original256 = hex(&Sha256::digest(b"verified archive"));
        let original512 = hex(&Sha512::digest(b"verified archive"));
        let corrupt256 = hex(&Sha256::digest(b"corrupted archive"));
        let corrupt512 = hex(&Sha512::digest(b"corrupted archive"));
        artifact.sha256 = Some(original256.clone());
        artifact.sha512 = None;
        verify_checksum(&artifact, &original256, &original512).unwrap();
        assert_eq!(
            verify_checksum(&artifact, &corrupt256, &corrupt512)
                .unwrap_err()
                .code,
            "checksum_mismatch"
        );
        artifact.sha256 = None;
        artifact.sha512 = Some(original512.clone());
        verify_checksum(&artifact, &original256, &original512).unwrap();
        assert_eq!(
            verify_checksum(&artifact, &corrupt256, &corrupt512)
                .unwrap_err()
                .code,
            "checksum_mismatch"
        );
        artifact.sha256 = Some(original256.clone());
        assert!(verify_checksum(&artifact, &original256, &corrupt512).is_err());
    }
    #[test]
    fn failed_publication_keeps_the_old_receipt_and_foreign_destination() {
        let directory = tempfile::tempdir().unwrap();
        let storage = Storage::open(directory.path().join("app")).unwrap();
        let root = catalog::root(&storage).join("managed/typescript");
        let old = root.join("old");
        let payload = root.join("staged");
        let target = root.join("collision");
        fs::create_dir_all(&old).unwrap();
        fs::create_dir_all(&payload).unwrap();
        fs::write(old.join("server"), "old").unwrap();
        fs::write(payload.join("server"), "new").unwrap();
        fs::write(&target, "external content").unwrap();
        let mut receipt = InstalledServer {
            version: "old".into(),
            enabled: true,
            executable: old.join("server").to_string_lossy().into(),
            arguments: vec![],
            environment: BTreeMap::new(),
            directory: Some(old),
        };
        catalog::save_installed(&storage, "typescript", &receipt).unwrap();
        receipt.version = "new".into();
        receipt.directory = Some(target.clone());
        assert!(
            publish(
                &storage,
                "typescript",
                &payload,
                &target,
                &receipt,
                &operation("typescript", "installing")
            )
            .is_err()
        );
        assert_eq!(
            catalog::installed(&storage, "typescript")
                .unwrap()
                .unwrap()
                .version,
            "old"
        );
        assert_eq!(fs::read_to_string(&target).unwrap(), "external content");
        assert!(payload.join("server").is_file());
    }
    #[test]
    fn cancellation_keeps_the_previous_published_installation() {
        let directory = tempfile::tempdir().unwrap();
        let storage = Storage::open(directory.path().join("app")).unwrap();
        let root = catalog::root(&storage).join("managed/typescript");
        let old = root.join("old");
        let payload = root.join("pending");
        fs::create_dir_all(&old).unwrap();
        fs::create_dir_all(&payload).unwrap();
        fs::write(old.join("server"), "old").unwrap();
        fs::write(payload.join("server"), "new").unwrap();
        let receipt = InstalledServer {
            version: "old".into(),
            enabled: true,
            executable: old.join("server").to_string_lossy().into(),
            arguments: vec![],
            environment: BTreeMap::new(),
            directory: Some(old.clone()),
        };
        catalog::save_installed(&storage, "typescript", &receipt).unwrap();
        let pending = operation("typescript", "installing");
        cancel(&pending);
        let target = root.join("new");
        let error = publish(
            &storage,
            "typescript",
            &payload,
            &target,
            &receipt,
            &pending,
        )
        .unwrap_err();
        assert_eq!(error.code, "installation_cancelled");
        assert!(!target.exists());
        assert!(payload.join("server").exists());
        assert_eq!(
            catalog::installed(&storage, "typescript")
                .unwrap()
                .unwrap()
                .version,
            "old"
        );
        assert_eq!(fs::read_to_string(old.join("server")).unwrap(), "old");
    }
    #[test]
    fn restart_marks_pending_work_interrupted_without_removing_installed_files() {
        let directory = tempfile::tempdir().unwrap();
        let storage = Storage::open(directory.path().join("app")).unwrap();
        let root = catalog::root(&storage);
        fs::create_dir_all(root.join("pending")).unwrap();
        let pending = operation("typescript", "installing");
        fs::write(
            root.join("pending/unfinished.json"),
            serde_json::to_vec(&*pending.progress.lock().unwrap()).unwrap(),
        )
        .unwrap();
        fs::create_dir_all(root.join("managed/typescript/.install-abandoned")).unwrap();
        fs::create_dir_all(root.join("managed/typescript/current")).unwrap();
        let installer = LanguageServerInstaller::default();
        installer.recover(&storage).unwrap();
        installer.recover(&storage).unwrap();
        assert_eq!(installer.operations().len(), 1);
        assert_eq!(installer.operations()[0].status, "interrupted");
        assert!(!root.join("managed/typescript/.install-abandoned").exists());
        assert!(root.join("managed/typescript/current").exists());
    }
    #[test]
    fn queued_installs_prevent_enable_and_removal() {
        let directory = tempfile::tempdir().unwrap();
        let storage = Storage::open(directory.path().join("app")).unwrap();
        let installer = LanguageServerInstaller::default();
        installer
            .owner
            .operations
            .lock()
            .unwrap()
            .push_back(operation("typescript", "queued"));
        assert_eq!(
            installer
                .set_enabled(&storage, "typescript", false)
                .unwrap_err()
                .code,
            "installation_busy"
        );
        assert_eq!(
            installer
                .uninstall(&storage, "typescript")
                .unwrap_err()
                .code,
            "installation_busy"
        );
    }
    #[test]
    fn archive_paths_and_links_stay_private() {
        assert!(safe_relative(Path::new("../outside")).is_err());
        assert!(safe_relative(Path::new("/outside")).is_err());
        assert!(safe_relative(Path::new("lib/server.js")).is_ok());
        assert!(
            safe_link(
                Path::new("/private"),
                Path::new("/private/bin/npm"),
                "../lib/npm.js"
            )
            .is_ok()
        );
        assert!(
            safe_link(
                Path::new("/private"),
                Path::new("/private/bin/npm"),
                "../../outside"
            )
            .is_err()
        );
    }
    #[test]
    fn every_npm_server_has_an_integrity_locked_dependency_tree() {
        let locks: BTreeMap<String, Value> =
            serde_json::from_str(include_str!("../../../resources/languages/npm-locks.json"))
                .unwrap();
        for server in catalog::specs()
            .unwrap()
            .into_iter()
            .filter(|entry| entry.method == "npm")
        {
            let lock = &locks[&server.id];
            assert_eq!(
                lock["packages"]["node_modules/".to_owned() + &server.package]["version"],
                server.version
            );
            for (name, package) in lock["packages"].as_object().unwrap() {
                if !name.is_empty() {
                    assert!(
                        package["integrity"].as_str().is_some_and(|value| value
                            .starts_with("sha512-")
                            || value.starts_with("sha1-")),
                        "Missing integrity: {name}"
                    );
                }
            }
        }
    }

    #[test]
    #[ignore = "Downloads pinned language packages into an isolated private installation"]
    fn managed_servers_initialize_after_private_install() {
        let temporary = tempfile::tempdir().unwrap();
        let directory = std::env::var_os("REVIEWBOX_LANGUAGE_SMOKE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| temporary.path().join("app"));
        let storage = Storage::open(directory).unwrap();
        let installer = LanguageServerInstaller::default();
        let selected = std::env::var("REVIEWBOX_LANGUAGE_SMOKE_IDS").ok();
        let mut failures = Vec::new();
        tauri::async_runtime::block_on(async {
            for server in catalog::specs().unwrap().into_iter().filter(|entry| {
                selected.as_ref().map_or(entry.method == "npm", |ids| {
                    ids.split(',').any(|id| id == entry.id)
                })
            }) {
                eprintln!("Installing {} {}", server.id, server.version);
                let operation = installer
                    .start(storage.clone(), server.id.clone(), None)
                    .unwrap();
                let deadline = Instant::now() + Duration::from_secs(600);
                loop {
                    let state = installer
                        .operations()
                        .into_iter()
                        .find(|item| item.id == operation.id)
                        .unwrap();
                    if !matches!(state.status.as_str(), "queued" | "installing") {
                        if state.status != "ready" {
                            failures.push(format!("{} install: {}", server.id, state.message));
                        }
                        break;
                    }
                    assert!(
                        Instant::now() < deadline,
                        "Timed out installing {}",
                        server.id
                    );
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                let Some(receipt) = catalog::installed(&storage, &server.id).unwrap() else {
                    continue;
                };
                let configuration = LanguageServerConfig {
                    id: server.id.clone(),
                    name: server.name.clone(),
                    extensions: server.extensions,
                    executable: receipt.executable,
                    arguments: receipt.arguments,
                };
                let result = super::super::tests::probe_server(
                    configuration,
                    receipt.environment.into_iter().collect(),
                    storage.clone(),
                )
                .await;
                match result {
                    Ok(capabilities) => eprintln!("Verified {}: {:?}", server.id, capabilities),
                    Err(error) => {
                        failures.push(format!("{} initialize: {}", server.id, error.message))
                    }
                }
            }
        });
        installer.shutdown();
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }
}
