use crate::{contracts::*, proposals, repositories, reviews, storage::Storage};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
};

pub(crate) fn dispatch(storage: &Storage, request: Value) -> AppResult<Value> {
    let path = request["repo"]
        .as_str()
        .ok_or_else(|| AppError::new("arguments", "A repository path is required."))?;
    let repository = repositories::open(storage, path)?;
    let scoped = storage.scoped(Some(&repository.id));
    let storage = &scoped;
    let settings = storage.project_settings(&repository.id)?;
    let method = request["method"].as_str().unwrap_or_default();
    if method == "init" {
        return Ok(serde_json::to_value(repository)?);
    }
    if method == "create" {
        let capture = CaptureRequest {
            repository_id: repository.id,
            scope: request
                .get("scope")
                .map(|v| serde_json::from_value(v.clone()))
                .transpose()?
                .unwrap_or(settings.default_scope),
            base: request["base"].as_str().map(String::from),
            target: request["target"].as_str().map(String::from),
            include_untracked: request["includeUntracked"]
                .as_bool()
                .unwrap_or(settings.include_untracked),
        };
        return Ok(serde_json::to_value(reviews::create(storage, capture)?)?);
    }
    if method == "tour" {
        let mut value = request["content"].clone();
        value["repositoryId"] = json!(repository.id);
        if value.get("id").is_none() {
            value["id"] = json!(id());
        }
        if value.get("revision").is_none() {
            value["revision"] = json!(0);
        }
        if value.get("createdAt").is_none() {
            value["createdAt"] = json!(now());
        }
        if value.get("updatedAt").is_none() {
            value["updatedAt"] = json!(now());
        }
        return Ok(serde_json::to_value(crate::onboarding::save(
            storage,
            serde_json::from_value(value)?,
        )?)?);
    }
    let review = storage
        .list::<Review>("review")?
        .into_iter()
        .filter(|r| {
            r.repository_id == repository.id
                && request["reviewId"].as_str().is_none_or(|id| id == r.id)
        })
        .max_by_key(|r| r.updated_at.parse::<u64>().unwrap_or(0))
        .ok_or_else(|| {
            AppError::new(
                "not_found",
                "Create a review first with reviewbox create --repo <path>.",
            )
        })?;
    let workspace = reviews::load(storage, &review.id)?;
    if method == "context" {
        return Ok(
            json!({"reviewId":review.id,"revision":review.revision,"snapshotId":workspace.snapshot.id,"changes":workspace.snapshot.changes,"files":workspace.snapshot.files}),
        );
    }
    if request["snapshotId"].as_str() != Some(&workspace.snapshot.id) {
        return Err(AppError::new(
            "stale_proposal",
            "Fetch context and target its exact snapshotId.",
        ));
    }
    match method {
        "propose" | "enrich" => {
            let proposal = proposals::parse(
                storage,
                &review.id,
                &serde_json::to_string(&request["content"])?,
                None,
            )?;
            if method == "propose" {
                return Ok(serde_json::to_value(proposal)?);
            }
            Ok(serde_json::to_value(proposals::answer(
                storage,
                &proposal.id,
                proposal.revision,
                proposal.content,
                true,
            )?)?)
        }
        "annotate" => {
            let anchor: CodeAnchor = serde_json::from_value(request["anchor"].clone())?;
            let body = request["body"]
                .as_str()
                .ok_or_else(|| AppError::new("arguments", "A comment body is required."))?
                .to_string();
            let mut next = reviews::prepare_action(
                storage,
                workspace,
                review.revision,
                ReviewAction::AddAnnotation {
                    anchor,
                    body,
                    question: request["question"].as_bool().unwrap_or(false),
                },
            )?;
            if let Some(note) = next.review.annotations.last_mut() {
                note.author = "agent:external".into();
            }
            storage.replace("review", &review.id, review.revision, &next.review)?;
            Ok(serde_json::to_value(next.review)?)
        }
        _ => Err(AppError::new(
            "method",
            "Unsupported agent action. Validation and question resolution are human actions.",
        )),
    }
}

#[cfg(unix)]
pub struct LocalBridge {
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
    path: PathBuf,
}
#[cfg(unix)]
impl LocalBridge {
    pub fn start(storage: Storage, directory: &Path) -> AppResult<Self> {
        use std::{
            os::unix::{fs::PermissionsExt, net::UnixListener},
            sync::{
                Arc,
                atomic::{AtomicBool, Ordering},
            },
            time::Duration,
        };
        let path = directory.join("bridge.sock");
        // The storage ownership lock is already held; no live owner can use this socket.
        if path.exists() {
            std::fs::remove_file(&path)?;
        }
        let listener = UnixListener::bind(&path)?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        listener.set_nonblocking(true)?;
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let worker = std::thread::spawn(move || {
            while !stopping.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                        let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
                        let mut bytes = Vec::new();
                        let result = BufReader::new(&mut stream)
                            .take(1024 * 1024 + 1)
                            .read_until(b'\n', &mut bytes)
                            .map_err(AppError::from)
                            .and_then(|_| {
                                if bytes.len() > 1024 * 1024 || bytes.last() != Some(&b'\n') {
                                    return Err(AppError::new(
                                        "request_limit",
                                        "Invalid or oversized request.",
                                    ));
                                }
                                dispatch(&storage, serde_json::from_slice(&bytes)?)
                            });
                        let envelope = match result {
                            Ok(value) => json!({"result":value}),
                            Err(error) => json!({"error":error}),
                        };
                        if let Ok(mut bytes) = serde_json::to_vec(&envelope) {
                            bytes.push(b'\n');
                            let _ = stream.write_all(&bytes);
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(50))
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(Self {
            stop,
            worker: Some(worker),
            path,
        })
    }
}
#[cfg(unix)]
impl Drop for LocalBridge {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        let _ = std::fs::remove_file(&self.path);
    }
}

fn data_directory() -> AppResult<PathBuf> {
    #[cfg(feature = "native-validation")]
    if let Some(path) = std::env::var_os("REVIEWBOX_VALIDATION_DATA") {
        return Ok(path.into());
    }
    #[cfg(target_os = "macos")]
    return std::env::var_os("HOME")
        .map(|h| PathBuf::from(h).join("Library/Application Support/com.naikho.reviewbox"))
        .ok_or_else(|| {
            AppError::new(
                "data_directory",
                "Cannot find the user application directory.",
            )
        });
    #[cfg(all(unix, not(target_os = "macos")))]
    return std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
        .map(|h| h.join("com.naikho.reviewbox"))
        .ok_or_else(|| {
            AppError::new(
                "data_directory",
                "Cannot find the user application directory.",
            )
        });
    #[cfg(not(unix))]
    Err(AppError::new(
        "platform",
        "The local integration transport is not available on this platform yet.",
    ))
}
pub fn request(value: Value) -> AppResult<Value> {
    #[cfg(unix)]
    {
        let directory = data_directory()?;
        let mut stream =
            match std::os::unix::net::UnixStream::connect(directory.join("bridge.sock")) {
                Ok(stream) => stream,
                Err(error)
                    if [
                        std::io::ErrorKind::NotFound,
                        std::io::ErrorKind::ConnectionRefused,
                    ]
                    .contains(&error.kind()) =>
                {
                    return dispatch(&Storage::open(directory)?, value);
                }
                Err(error) => return Err(error.into()),
            };
        stream.set_read_timeout(Some(std::time::Duration::from_secs(15)))?;
        stream.set_write_timeout(Some(std::time::Duration::from_secs(15)))?;
        let mut bytes = serde_json::to_vec(&value)?;
        bytes.push(b'\n');
        stream.write_all(&bytes)?;
        let mut line = Vec::new();
        BufReader::new(stream)
            .take(8 * 1024 * 1024 + 1)
            .read_until(b'\n', &mut line)?;
        if line.len() > 8 * 1024 * 1024 {
            return Err(AppError::new(
                "response_limit",
                "Context is too large for this integration.",
            ));
        }
        let value: Value = serde_json::from_slice(&line)?;
        if let Some(error) = value.get("error") {
            return Err(serde_json::from_value(error.clone())?);
        }
        Ok(value["result"].clone())
    }
    #[cfg(not(unix))]
    {
        let _ = value;
        Err(AppError::new(
            "platform",
            "Local integrations are currently available on macOS and Linux.",
        ))
    }
}
fn agent_tools() -> Vec<Value> {
    [
        ("context","Read review anchors and snapshot metadata.",vec![]),
        ("create","Capture a new review without changing Git.",vec![]),
        ("propose","Submit content for human acceptance.",vec!["snapshotId","content"]),
        ("enrich","Add topics, explanations or glossary entries directly.",vec!["snapshotId","content"]),
        ("annotate","Add a comment or an open question.",vec!["snapshotId","anchor","body"]),
        ("tour","Create or update an onboarding tour.",vec!["content"]),
    ].into_iter().map(|(name,description,required)| {
        let mut properties=json!({"repo":{"type":"string"},"reviewId":{"type":"string"}});
        match name {
            "create" => { properties["scope"]=json!({"enum":["local","staged","unstaged","commit","range"]}); properties["base"]=json!({"type":"string"}); properties["target"]=json!({"type":"string"}); properties["includeUntracked"]=json!({"type":"boolean"}); },
            "propose"|"enrich" => { properties["snapshotId"]=json!({"type":"string"}); properties["content"]=json!({"type":"object"}); },
            "annotate" => { properties["snapshotId"]=json!({"type":"string"}); properties["anchor"]=json!({"type":"object"}); properties["body"]=json!({"type":"string"}); properties["question"]=json!({"type":"boolean"}); },
            "tour" => properties["content"]=json!({"type":"object"}), _ => {},
        }
        let mut fields=vec!["repo"]; fields.extend(required);
        json!({"name":format!("reviewbox_{name}"),"description":description,"inputSchema":{"type":"object","properties":properties,"required":fields,"additionalProperties":false},"annotations":{"readOnlyHint":name=="context","destructiveHint":false,"openWorldHint":false}})
    }).collect()
}
fn mcp() -> AppResult<()> {
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    let mut stdout = std::io::stdout().lock();
    loop {
        let mut line = Vec::new();
        if (&mut input)
            .take(1024 * 1024 + 1)
            .read_until(b'\n', &mut line)?
            == 0
        {
            break;
        }
        if line.len() > 1024 * 1024 {
            return Err(AppError::new("request_limit", "MCP message exceeds 1 MiB."));
        }
        let message: Value = match serde_json::from_slice(&line) {
            Ok(v) => v,
            Err(_) => {
                writeln!(
                    stdout,
                    "{}",
                    json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Invalid JSON"}})
                )?;
                stdout.flush()?;
                continue;
            }
        };
        let Some(id) = message.get("id") else {
            continue;
        };
        let response = match message["method"].as_str() {
            Some("initialize") => {
                json!({"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"reviewbox","version":env!("CARGO_PKG_VERSION")}}})
            }
            Some("ping") => json!({"result":{}}),
            Some("tools/list") => json!({"result":{"tools":agent_tools()}}),
            Some("tools/call") => {
                let method = match message["params"]["name"].as_str() {
                    Some("reviewbox_context") => Some("context"),
                    Some("reviewbox_propose") => Some("propose"),
                    Some("reviewbox_create") => Some("create"),
                    Some("reviewbox_enrich") => Some("enrich"),
                    Some("reviewbox_annotate") => Some("annotate"),
                    Some("reviewbox_tour") => Some("tour"),
                    _ => None,
                };
                if let Some(method) = method {
                    let mut args = message["params"]["arguments"].clone();
                    if let Some(object) = args.as_object_mut() {
                        object.insert("method".into(), json!(method));
                    }
                    match request(args) {
                        Ok(value) => {
                            json!({"result":{"content":[{"type":"text","text":serde_json::to_string(&value)?}],"structuredContent":value,"isError":false}})
                        }
                        Err(error) => {
                            json!({"result":{"content":[{"type":"text","text":error.message}],"isError":true}})
                        }
                    }
                } else {
                    json!({"error":{"code":-32602,"message":"Unknown tool"}})
                }
            }
            _ => json!({"error":{"code":-32601,"message":"Unknown method"}}),
        };
        let mut response = response;
        response["jsonrpc"] = json!("2.0");
        response["id"] = id.clone();
        writeln!(stdout, "{}", serde_json::to_string(&response)?)?;
        stdout.flush()?;
    }
    Ok(())
}
pub fn run_cli() -> bool {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(command) = args.first().filter(|c| {
        [
            "init", "create", "context", "propose", "enrich", "annotate", "tour", "mcp",
        ]
        .contains(&c.as_str())
    }) else {
        return false;
    };
    let result = (|| -> AppResult<()> {
        if command == "mcp" {
            return mcp();
        }
        let flag = |name: &str| {
            args.windows(2)
                .find(|a| a[0] == name)
                .map(|a| a[1].as_str())
        };
        let repo = Path::new(flag("--repo").unwrap_or(".")).canonicalize()?;
        let mut value = json!({"method":command,"repo":repo,"reviewId":flag("--review")});
        if ["propose", "enrich", "annotate", "tour"].contains(&command.as_str())
            || flag("--from").is_some()
        {
            let path = flag("--from").ok_or_else(|| {
                AppError::new(
                    "arguments",
                    "Use propose --repo <path> --from <proposal.json>.",
                )
            })?;
            if std::fs::metadata(path)?.len() > 1024 * 1024 {
                return Err(AppError::new(
                    "request_limit",
                    "Proposal file exceeds 1 MiB.",
                ));
            }
            let envelope: Value = serde_json::from_slice(&std::fs::read(path)?)?;
            let object = envelope
                .as_object()
                .ok_or_else(|| AppError::new("arguments", "Expected a JSON request object."))?;
            for (key, content) in object {
                if !["method", "repo"].contains(&key.as_str()) {
                    value[key] = content.clone();
                }
            }
        }
        println!("{}", serde_json::to_string_pretty(&request(value)?)?);
        Ok(())
    })();
    if let Err(error) = result {
        eprintln!("{}: {}", error.code, error.message);
        std::process::exit(1);
    }
    true
}
