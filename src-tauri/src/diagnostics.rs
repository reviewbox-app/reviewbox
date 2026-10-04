//! Private, bounded diagnostics. No source buffers, prompts, IPC arguments or
//! provider transcripts are collected. Logging never fails a user operation.
mod redaction;
pub(crate) use redaction::redact;
#[cfg(test)]
mod tests;

use crate::contracts::*;
use std::{
    collections::VecDeque,
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const FILES: [&str; 3] = ["errors.jsonl", "errors.1.jsonl", "errors.2.jsonl"];
const CONTEXT_KEYS: [&str; 10] = [
    "repositoryId",
    "reviewId",
    "snapshotId",
    "operationId",
    "provider",
    "phase",
    "batchId",
    "window",
    "model",
    "harnessVersion",
];

pub(crate) struct Diagnostics {
    directory: PathBuf,
    session: String,
    recent: Mutex<VecDeque<(String, Instant, DiagnosticEntry)>>,
    max_file_bytes: u64,
}

impl Diagnostics {
    pub(crate) fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            session: id(),
            recent: Mutex::default(),
            max_file_bytes: MAX_FILE_BYTES,
        }
    }

    pub(crate) fn record(&self, mut input: DiagnosticInput) -> AppResult<DiagnosticEntry> {
        input.source = redact(&input.source, 64);
        input.operation = redact(&input.operation, 256);
        input.code = redact(&input.code, 128);
        input.message = redact(&input.message, 2048);
        input.details = input.details.map(|s| redact(&s, 16_384));
        input.stack = input.stack.map(|s| redact(&s, 8192));
        input
            .context
            .retain(|key, _| CONTEXT_KEYS.contains(&key.as_str()));
        for value in input.context.values_mut() {
            *value = redact(value, 256);
        }
        let fingerprint = fingerprint(&serde_json::to_vec(&input)?);
        let mut recent = self
            .recent
            .lock()
            .map_err(|_| AppError::new("diagnostics", "Error log is unavailable."))?;
        if let Some((_, _, entry)) = recent
            .iter()
            .find(|(key, time, _)| key == &fingerprint && time.elapsed() < Duration::from_secs(10))
        {
            return Ok(entry.clone());
        }
        let entry = DiagnosticEntry {
            id: id(),
            timestamp: now(),
            session_id: self.session.clone(),
            app_version: env!("CARGO_PKG_VERSION").into(),
            platform: std::env::consts::OS.into(),
            error: input,
        };
        let mut bytes = serde_json::to_vec(&entry)?;
        bytes.push(b'\n');
        self.ensure_directory()?;
        for name in FILES {
            check_path(&self.directory.join(name), false)?;
        }
        let path = self.directory.join(FILES[0]);
        if fs::metadata(&path).is_ok_and(|m| m.len() + bytes.len() as u64 > self.max_file_bytes) {
            for index in (1..FILES.len()).rev() {
                let source = self.directory.join(FILES[index - 1]);
                let dest = self.directory.join(FILES[index]);
                if dest.exists() {
                    fs::remove_file(&dest)?;
                }
                if source.exists() {
                    fs::rename(source, dest)?;
                }
            }
        }
        let mut options = fs::OpenOptions::new();
        options.create(true).append(true).read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))?;
        }
        // A process interrupted during append must not swallow the next record.
        if file.metadata()?.len() > 0 {
            file.seek(SeekFrom::End(-1))?;
            let mut last = [0];
            file.read_exact(&mut last)?;
            if last[0] != b'\n' {
                file.write_all(b"\n")?;
            }
        }
        file.write_all(&bytes)?;
        file.sync_data()?;
        recent.push_back((fingerprint, Instant::now(), entry.clone()));
        while recent.len() > 128 {
            recent.pop_front();
        }
        Ok(entry)
    }

    fn ensure_directory(&self) -> AppResult<()> {
        check_path(&self.directory, true)?;
        fs::create_dir_all(&self.directory)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&self.directory, fs::Permissions::from_mode(0o700))?;
        }
        Ok(())
    }

    fn read(&self) -> AppResult<DiagnosticLog> {
        let _read = self
            .recent
            .lock()
            .map_err(|_| AppError::new("diagnostics", "Error log is unavailable."))?;
        let mut entries = Vec::new();
        check_path(&self.directory, true)?;
        for name in FILES {
            let path = self.directory.join(name);
            check_path(&path, false)?;
            if !path.exists() {
                continue;
            }
            if fs::metadata(&path)?.len() > MAX_FILE_BYTES + 65_536 {
                continue;
            }
            for line in String::from_utf8_lossy(&fs::read(path)?).lines().rev() {
                if let Ok(entry) = serde_json::from_str::<DiagnosticEntry>(line) {
                    entries.push(entry);
                }
                if entries.len() == 200 {
                    break;
                }
            }
            if entries.len() == 200 {
                break;
            }
        }
        Ok(DiagnosticLog {
            directory: self.directory.to_string_lossy().into(),
            entries,
        })
    }
}

fn check_path(path: &Path, directory: bool) -> AppResult<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if (directory && meta.is_dir()) || (!directory && meta.is_file()) => Ok(()),
        Ok(_) => Err(AppError::new(
            "diagnostics",
            "The error log path is not a regular local file or directory.",
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub(crate) fn preparation_input(
    repository_id: &str,
    state: &PreparationState,
    error: &AppError,
) -> DiagnosticInput {
    DiagnosticInput {
        source: "rev".into(),
        operation: "review_preparation".into(),
        code: error.code.clone(),
        message: error.message.clone(),
        details: error.details.clone(),
        stack: None,
        context: [
            ("repositoryId", repository_id.to_owned()),
            ("reviewId", state.review_id.clone()),
            ("snapshotId", state.snapshot_id.clone()),
            ("operationId", state.id.clone()),
            ("provider", state.provider.clone()),
            ("phase", format!("{:?}", state.phase)),
        ]
        .into_iter()
        .map(|(k, v)| (k.into(), v))
        .collect(),
    }
}

pub(crate) fn install_panic_hook(log: &Arc<Diagnostics>) {
    let log = Arc::downgrade(log);
    let previous = std::panic::take_hook();
    // The process-level hook owns only a weak reference to managed state.
    std::panic::set_hook(Box::new(move |panic| {
        if let Some(log) = log.upgrade() {
            // A panic inside logging must not deadlock or recursively panic.
            if log.recent.try_lock().is_ok() {
                let input = DiagnosticInput {
                    source: "native".into(),
                    operation: "panic".into(),
                    code: "panic".into(),
                    message: panic.to_string(),
                    details: panic.location().map(ToString::to_string),
                    stack: Some(std::backtrace::Backtrace::force_capture().to_string()),
                    context: Default::default(),
                };
                let _ = log.record(input);
            }
        }
        previous(panic);
    }));
}

#[tauri::command]
pub(crate) async fn diagnostics_record(
    log: tauri::State<'_, Arc<Diagnostics>>,
    input: DiagnosticInput,
    diagnostic_id: Option<String>,
) -> AppResult<DiagnosticEntry> {
    let log = log.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(id) = diagnostic_id
            && let Ok(saved) = log.read()
            && let Some(entry) = saved.entries.into_iter().find(|entry| entry.id == id)
        {
            return Ok(entry);
        }
        log.record(input)
    })
    .await
    .map_err(|e| AppError::new("diagnostics", e.to_string()))?
}

#[tauri::command]
pub(crate) async fn diagnostics_read(
    log: tauri::State<'_, Arc<Diagnostics>>,
) -> AppResult<DiagnosticLog> {
    let log = log.inner().clone();
    tauri::async_runtime::spawn_blocking(move || log.read())
        .await
        .map_err(|e| AppError::new("diagnostics", e.to_string()))?
}

#[tauri::command]
pub(crate) async fn diagnostics_reveal(log: tauri::State<'_, Arc<Diagnostics>>) -> AppResult<()> {
    let log = log.inner().clone();
    let directory = tauri::async_runtime::spawn_blocking(move || {
        log.ensure_directory()?;
        Ok::<_, AppError>(log.directory.clone())
    })
    .await
    .map_err(|e| AppError::new("diagnostics", e.to_string()))??;
    #[cfg(target_os = "macos")]
    let opener = "open";
    #[cfg(target_os = "windows")]
    let opener = "explorer";
    #[cfg(all(unix, not(target_os = "macos")))]
    let opener = "xdg-open";
    if !tokio::process::Command::new(opener)
        .arg(directory)
        .status()
        .await?
        .success()
    {
        return Err(AppError::new(
            "diagnostics",
            "Could not open the error log folder.",
        ));
    }
    Ok(())
}
