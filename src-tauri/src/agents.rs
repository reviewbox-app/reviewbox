mod claude;
mod codex;
use crate::{contracts::*, knowledge, prompts, reviews, storage::Storage};
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
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout},
};

#[derive(Default)]
pub struct AgentManager {
    active: Mutex<HashMap<String, Arc<AtomicBool>>>,
}
impl AgentManager {
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
    group: crate::processes::ProcessGroup,
    child: Child,
    input: ChildStdin,
    output: tokio::io::Lines<BufReader<ChildStdout>>,
    cancel: Arc<AtomicBool>,
    deadline: tokio::time::Instant,
}
impl Transport {
    fn new(mut command: tokio::process::Command, cancel: Arc<AtomicBool>) -> AppResult<Self> {
        command
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
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
            group,
            child,
            input,
            output,
            cancel,
            deadline: tokio::time::Instant::now() + Duration::from_secs(300),
        })
    }
    async fn send(&mut self, value: &Value) -> AppResult<()> {
        let mut bytes = serde_json::to_vec(value)?;
        bytes.push(b'\n');
        self.input.write_all(&bytes).await?;
        self.input.flush().await?;
        Ok(())
    }
    async fn next(&mut self) -> AppResult<Value> {
        loop {
            if self.cancel.load(Ordering::Relaxed) {
                return Err(AppError::new("cancelled", "Agent request stopped."));
            }
            if tokio::time::Instant::now() > self.deadline {
                return Err(AppError::new(
                    "timeout",
                    "Agent request exceeded five minutes.",
                ));
            }
            match tokio::time::timeout(Duration::from_millis(200), self.output.next_line()).await {
                Err(_) => continue,
                Ok(Err(e)) => return Err(e.into()),
                Ok(Ok(None)) => {
                    return Err(AppError::new(
                        "provider_exited",
                        "Provider exited before completing. Check its CLI configuration and authentication.",
                    ));
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
}
impl Stream {
    fn emit(&mut self, kind: &str, text: &str) -> AppResult<()> {
        self.sequence += 1;
        if kind == "delta" {
            if self.text.len() + text.len() > 2 * 1024 * 1024 {
                return Err(AppError::new("output_limit", "Agent output exceeds 2 MiB."));
            }
            self.text.push_str(text);
        }
        self.channel
            .send(AgentEvent {
                run_id: self.id.clone(),
                sequence: self.sequence,
                kind: kind.into(),
                text: text.into(),
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
pub(crate) fn prepare(
    storage: &Storage,
    resources: &std::path::Path,
    request: &AgentRequest,
) -> AppResult<AgentRun> {
    if !["codex", "claude"].contains(&request.provider.as_str()) {
        return Err(AppError::new("provider", "Unknown provider."));
    }
    if request.paths.is_empty() || request.request.len() > 32000 {
        return Err(AppError::new(
            "context",
            "Select at least one file and keep the question below 32000 bytes.",
        ));
    }
    let workspace = reviews::load(storage, &request.review_id)?;
    let mut context = String::new();
    for path in &request.paths {
        if excluded(path) {
            return Err(AppError::new(
                "excluded_context",
                format!("{path} is excluded from agent context."),
            ));
        }
        let file = workspace.snapshot.files.iter().find(|f| &f.path == path);
        let Some(file) = file else {
            if workspace.snapshot.changes.iter().any(|c| &c.path == path) {
                continue;
            }
            return Err(AppError::new(
                "context",
                "File is not present in this snapshot.",
            ));
        };
        if file.content.size > 128 * 1024
            || !matches!(file.content.mode.as_str(), "100644" | "100755")
        {
            return Err(AppError::new(
                "context_limit",
                format!("{path} cannot be included as a text file (128 KiB limit)."),
            ));
        }
        let content = String::from_utf8(storage.read_blob(&file.content.hash)?)
            .map_err(|_| AppError::new("encoding", "Agent context must be UTF-8 text."))?;
        if content.contains('\0') {
            return Err(AppError::new(
                "encoding",
                "Binary files cannot be sent to the agent.",
            ));
        }
        context.push_str(&format!(
            "\nFile: {path}\nContent hash: {}\n",
            file.content.hash
        ));
        for (index, line) in content.lines().enumerate() {
            context.push_str(&format!("{}: {line}\n", index + 1));
        }
        if context.len() > 512 * 1024 {
            return Err(AppError::new(
                "context_limit",
                "Selected context exceeds 512 KiB. Choose fewer files.",
            ));
        }
    }
    // Supply exact canonical anchors and both sides of every selected diff layer.
    for change in workspace
        .snapshot
        .changes
        .iter()
        .filter(|c| request.paths.contains(&c.path))
    {
        let read = |blob: &Option<BlobRef>| -> AppResult<Option<String>> {
            blob.as_ref()
                .map(|b| {
                    if b.size > 128 * 1024 || !matches!(b.mode.as_str(), "100644" | "100755") {
                        return Err(AppError::new(
                            "context_limit",
                            "Selected diff side exceeds the text context limit.",
                        ));
                    }
                    String::from_utf8(storage.read_blob(&b.hash)?)
                        .map_err(|_| AppError::new("encoding", "Diff contains non-UTF-8 content."))
                })
                .transpose()
        };
        let anchors: Vec<_> = change
            .passages
            .iter()
            .map(|p| CodeAnchor {
                snapshot_id: workspace.snapshot.id.clone(),
                change_id: change.id.clone(),
                passage_id: p.id.clone(),
            })
            .collect();
        context.push_str(&serde_json::to_string(&serde_json::json!({"change": change, "anchors": anchors, "before": read(&change.before)?, "after": read(&change.after)?}))?);
        if context.len() > 512 * 1024 {
            return Err(AppError::new(
                "context_limit",
                "Selected context exceeds 512 KiB. Choose fewer files.",
            ));
        }
    }
    let contract = match request.action.as_str() {
        "topics" => "topics",
        "file" | "block" | "refresh" => "explanation",
        "glossary" => "glossary",
        _ => "answer",
    };
    let schema = std::fs::read_to_string(resources.join(format!("contracts/{contract}.md")))?;
    let language = knowledge::load(storage, &workspace.review.repository_id)?.language;
    let variables = BTreeMap::from([
        ("language".into(), language),
        ("snapshot_id".into(), workspace.snapshot.id.clone()),
        ("request".into(), request.request.clone()),
        ("context".into(), context),
        ("schema".into(), schema),
    ]);
    let mut prompt = prompts::load(resources, &request.action, &variables)?;
    prompt.sources.push(format!("contracts/{contract}.md"));
    Ok(AgentRun {
        id: request.id.clone(),
        review_id: request.review_id.clone(),
        snapshot_id: workspace.snapshot.id,
        provider: request.provider.clone(),
        action: request.action.clone(),
        prompt,
        paths: request.paths.clone(),
        output: String::new(),
        status: "running".into(),
        created_at: now(),
    })
}
pub async fn run(
    storage: Storage,
    resources: PathBuf,
    request: AgentRequest,
    cancel: Arc<AtomicBool>,
    channel: Channel<AgentEvent>,
) -> AppResult<AgentRun> {
    let mut run = prepare(&storage, &resources, &request)?;
    storage.insert("agent_run", &run.id, &run)?;
    let directory = tempfile::tempdir()?;
    let mut stream = Stream {
        id: run.id.clone(),
        sequence: 0,
        channel,
        text: String::new(),
    };
    let mut config = settings(&storage)?
        .providers
        .into_iter()
        .find(|p| p.provider == run.provider)
        .ok_or_else(|| AppError::new("provider", "Provider is not configured."))?;
    let review: Review = storage.get("review", &run.review_id)?;
    let project = storage.project_settings(&review.repository_id)?;
    if project
        .provider
        .as_deref()
        .is_none_or(|p| p == run.provider)
        && project.model.is_some()
    {
        config.model = project.model;
    }
    let result = match run.provider.as_str() {
        "codex" => {
            codex::run(
                directory.path(),
                &run.prompt.text,
                &config,
                cancel,
                &mut stream,
            )
            .await
        }
        "claude" => {
            claude::run(
                directory.path(),
                &run.prompt.text,
                &config,
                cancel,
                &mut stream,
            )
            .await
        }
        _ => unreachable!(),
    };
    run.output = stream.text.clone();
    run.status = match &result {
        Ok(()) => "completed",
        Err(e) if e.code == "cancelled" => "cancelled",
        Err(_) => "failed",
    }
    .into();
    storage.replace("agent_run", &run.id, 0, &run)?;
    match result {
        Ok(()) => {
            stream.emit("completed", "")?;
            Ok(run)
        }
        Err(error) => {
            let _ = stream.emit(&run.status, &error.message);
            Err(error)
        }
    }
}

pub fn settings(storage: &Storage) -> AppResult<ProviderSettings> {
    match storage.get("providers", "settings") {
        Ok(v) => Ok(v),
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
                        model: None,
                    }
                })
                .collect();
            Ok(ProviderSettings {
                revision: 0,
                default_provider: "codex".into(),
                providers,
            })
        }
        Err(e) => Err(e),
    }
}
pub fn configure(storage: &Storage, mut value: ProviderSettings) -> AppResult<ProviderSettings> {
    if value.providers.len() != 2
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
