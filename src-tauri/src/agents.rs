mod claude;
mod codex;
pub(crate) mod commit;
mod exploration;
pub(crate) mod language_setup;
mod outline_preview;
mod preparation;
pub(crate) use preparation::{PreparationRuntime, capture_summary};
pub(crate) mod models;
pub(crate) mod providers;
pub(crate) mod setup;
#[cfg(test)]
mod tests;
use crate::{contracts::*, prompts, reviews, storage::Storage};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tauri::ipc::Channel;
mod stderr;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout},
};

#[derive(Default)]
pub struct AgentManager {
    active: Mutex<HashMap<String, Arc<AtomicBool>>>,
}
impl AgentManager {
    pub fn is_active(&self, id: &str) -> bool {
        self.active
            .lock()
            .is_ok_and(|active| active.contains_key(id))
    }
    pub fn cancel(&self, id: &str) -> AppResult<()> {
        if let Some(flag) = self
            .active
            .lock()
            .map_err(|_| AppError::new("state", "Agent state unavailable."))?
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
    pub fn register(&self, id: &str) -> AppResult<Arc<AtomicBool>> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| AppError::new("state", "Agent state unavailable."))?;
        if active.contains_key(id) || active.len() >= 2 {
            return Err(AppError::new(
                "agent_busy",
                "Wait for an active agent request to finish.",
            ));
        }
        let flag = Arc::new(AtomicBool::new(false));
        active.insert(id.into(), flag.clone());
        Ok(flag)
    }
    pub fn remove(&self, id: &str) {
        if let Ok(mut active) = self.active.lock() {
            active.remove(id);
        }
    }
}
struct Transport {
    stderr: stderr::Stderr,
    read_only: bool,
    group: crate::processes::ProcessGroup,
    child: Child,
    input: Option<ChildStdin>,
    output: tokio::io::Lines<BufReader<ChildStdout>>,
    cancel: Arc<AtomicBool>,
}
impl Transport {
    fn new(mut command: tokio::process::Command, cancel: Arc<AtomicBool>) -> AppResult<Self> {
        command
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        {
            command.process_group(0);
        }
        let mut child = command.spawn()?;
        let group = crate::processes::ProcessGroup::new(
            child
                .id()
                .ok_or_else(|| AppError::new("process", "Missing process ID."))?,
        );
        let input = child
            .stdin
            .take()
            .ok_or_else(|| AppError::new("process", "Missing process input."))?;
        let output = BufReader::new(
            child
                .stdout
                .take()
                .ok_or_else(|| AppError::new("process", "Missing process output."))?,
        )
        .lines();
        Ok(Self {
            stderr: stderr::Stderr::capture(
                child
                    .stderr
                    .take()
                    .ok_or_else(|| AppError::new("process", "Missing process stderr."))?,
            ),
            read_only: false,
            group,
            child,
            input: Some(input),
            output,
            cancel,
        })
    }
    async fn send(&mut self, value: &Value) -> AppResult<()> {
        let mut bytes = if value.pointer("/params/outputSchema").is_some() {
            outline_preview::schema_message(value)?
        } else {
            serde_json::to_vec(value)?
        };
        bytes.push(b'\n');
        let input = self
            .input
            .as_mut()
            .ok_or_else(|| AppError::new("process", "Provider input is closed."))?;
        input.write_all(&bytes).await?;
        input.flush().await?;
        Ok(())
    }
    async fn send_text_and_close(&mut self, text: &str) -> AppResult<()> {
        let mut input = self
            .input
            .take()
            .ok_or_else(|| AppError::new("process", "Provider input is closed."))?;
        input.write_all(text.as_bytes()).await?;
        input.flush().await?;
        // ChildStdin::shutdown is a no-op for Unix pipes. Dropping the owned
        // handle is required for print-mode CLIs to receive EOF and start.
        drop(input);
        Ok(())
    }
    async fn next(&mut self) -> AppResult<Value> {
        loop {
            if self.cancel.load(Ordering::Relaxed) {
                return Err(AppError::new("cancelled", "Agent request stopped."));
            }
            match tokio::time::timeout(Duration::from_millis(200), self.output.next_line()).await {
                Err(_) => continue,
                Ok(Err(e)) => return Err(e.into()),
                Ok(Ok(None)) => {
                    let stderr = self.stderr.text().await;
                    let status = self
                        .child
                        .try_wait()
                        .ok()
                        .flatten()
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| "stdout closed".into());
                    return Err(AppError::new(
                        "provider_exited",
                        "Provider exited before completing. Check its CLI configuration and authentication.",
                    ).with_details(format!("Process status: {status}\n\nStderr:\n{stderr}")));
                }
                Ok(Ok(Some(line))) => {
                    if line.len() > 4 * 1024 * 1024 {
                        return Err(AppError::new(
                            "protocol_limit",
                            "Provider message exceeds 4 MiB.",
                        ));
                    }
                    if line.trim().is_empty() {
                        continue;
                    }
                    return serde_json::from_str(&line).map_err(Into::into);
                }
            }
        }
    }
    async fn finish(&mut self) {
        self.group.terminate();
        let _ = self.child.kill().await;
        let _ = self.child.wait().await;
    }
}
struct Stream {
    id: String,
    sequence: u32,
    channel: Channel<AgentEvent>,
    text: String,
    preview: Option<outline_preview::Preview>,
}
impl Stream {
    fn emit(&mut self, kind: &str, text: &str) -> AppResult<()> {
        self.send(kind, text, None)
    }
    fn progress(&mut self, progress: AgentProgress) -> AppResult<()> {
        self.send("progress", "", Some(progress))
    }
    fn send(&mut self, kind: &str, text: &str, progress: Option<AgentProgress>) -> AppResult<()> {
        self.sequence += 1;
        if kind == "delta" {
            if self.text.len() + text.len() > 2 * 1024 * 1024 {
                return Err(AppError::new("output_limit", "Agent output exceeds 2 MiB."));
            }
            self.text.push_str(text);
        }
        self.channel
            .send(AgentEvent {
                batch_id: None,
                run_id: self.id.clone(),
                sequence: self.sequence,
                kind: kind.into(),
                text: text.into(),
                progress,
            })
            .map_err(|_| AppError::new("cancelled", "The receiving window is no longer available."))
    }
}
fn excluded(path: &str) -> bool {
    path.split('/').any(|part| {
        part == ".env"
            || part.starts_with(".env.")
            || part == ".git"
            || part == ".ssh"
            || part == ".aws"
            || part.ends_with(".pem")
            || part.ends_with(".key")
    })
}
/// The review scope is informational; the harness owns file discovery and context.
pub(crate) fn preparation_context(
    storage: &Storage,
    review_id: &str,
) -> AppResult<AgentPreparationContext> {
    let workspace = reviews::load(storage, review_id)?;
    let repository: Repository = storage.get("repository", &workspace.review.repository_id)?;
    Ok(AgentPreparationContext {
        snapshot_id: workspace.snapshot.id,
        project_path: repository.path,
        changed_files: workspace
            .snapshot
            .changes
            .iter()
            .map(|change| &change.path)
            .collect::<std::collections::BTreeSet<_>>()
            .len() as u32,
    })
}

pub fn settings(storage: &Storage) -> AppResult<ProviderSettings> {
    match storage.get::<ProviderSettings>("providers", "settings") {
        Ok(mut v) => {
            if v.model_defaults_version == 0 {
                for config in &mut v.providers {
                    if config.model.as_deref().is_none_or(|m| m.trim().is_empty()) {
                        config.model = models::default_model(&config.provider).map(str::to_owned);
                    }
                }
                // configure uses an optimistic revision: another window cannot
                // have its explicit model selection overwritten by migration.
                match configure(storage, v.clone()) {
                    Err(error) if error.code == "conflict" => storage.get("providers", "settings"),
                    result => result,
                }
            } else {
                Ok(v)
            }
        }
        Err(e) if e.code == "not_found" => {
            let directories: Vec<PathBuf> = std::env::var_os("PATH")
                .map(|s| std::env::split_paths(&s).collect())
                .unwrap_or_default();
            let providers = ["codex", "claude"]
                .iter()
                .map(|provider| {
                    let mut candidates: Vec<PathBuf> =
                        directories.iter().map(|p| p.join(provider)).collect();
                    if let Some(home) = std::env::var_os("HOME") {
                        for directory in [".local/bin", ".bun/bin", ".cargo/bin"] {
                            candidates.push(PathBuf::from(&home).join(directory).join(provider));
                        }
                    }
                    for directory in ["/opt/homebrew/bin", "/usr/local/bin"] {
                        candidates.push(PathBuf::from(directory).join(provider));
                    }
                    ProviderConfig {
                        provider: (*provider).into(),
                        executable: candidates
                            .into_iter()
                            .find(|p| p.is_file())
                            .map(|p| p.to_string_lossy().into_owned())
                            .unwrap_or_else(|| (*provider).into()),
                        model: models::default_model(provider).map(str::to_owned),
                    }
                })
                .collect();
            Ok(ProviderSettings {
                helper_model: "gpt-6-luna".into(),
                revision: 0,
                model_defaults_version: 1,
                default_provider: "codex".into(),
                providers,
            })
        }
        Err(e) => Err(e),
    }
}
pub fn configure(storage: &Storage, mut value: ProviderSettings) -> AppResult<ProviderSettings> {
    value.model_defaults_version = 1;
    if value.helper_model.trim().is_empty()
        || value.helper_model.len() > 256
        || value.helper_model.contains('\0')
        || value.providers.len() != 2
        || !["codex", "claude"].iter().all(|provider| {
            value
                .providers
                .iter()
                .filter(|p| p.provider == *provider)
                .count()
                == 1
        })
        || !value
            .providers
            .iter()
            .any(|p| p.provider == value.default_provider)
        || value.providers.iter().any(|p| {
            p.executable.trim().is_empty()
                || p.executable.contains('\0')
                || p.model.as_ref().is_some_and(|m| m.len() > 256)
        })
    {
        return Err(AppError::new(
            "provider_settings",
            "Configure one executable for each supported provider and a valid default.",
        ));
    }
    let previous: Option<ProviderSettings> = match storage.get("providers", "settings") {
        Ok(v) => Some(v),
        Err(e) if e.code == "not_found" => None,
        Err(e) => return Err(e),
    };
    if previous
        .as_ref()
        .is_some_and(|p| p.revision != value.revision)
    {
        return Err(AppError::new(
            "conflict",
            "Provider settings changed. Reload them before saving.",
        ));
    }
    let revision = previous.map(|p| p.revision);
    value.revision = revision.map_or(0, |r| r + 1);
    storage.write_batch(vec![(
        "providers",
        "settings",
        revision,
        serde_json::to_value(&value)?,
    )])?;
    Ok(value)
}

#[cfg(all(test, unix))]
mod transport_tests {
    use super::*;

    #[test]
    fn print_mode_receives_eof_before_waiting_for_a_response() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let mut transport = Transport::new(
                tokio::process::Command::new("/bin/cat"),
                Arc::new(AtomicBool::new(false)),
            )
            .unwrap();
            transport
                .send_text_and_close("{\"ok\":true}\n")
                .await
                .unwrap();
            assert_eq!(transport.next().await.unwrap()["ok"], true);
            let result = tokio::time::timeout(Duration::from_secs(2), transport.child.wait()).await;
            transport.finish().await;
            assert!(
                result
                    .expect("cat must exit after input EOF")
                    .unwrap()
                    .success()
            );
        });
    }
}
