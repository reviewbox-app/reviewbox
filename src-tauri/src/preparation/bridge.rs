//! Session-scoped MCP stdio proxy. The app owns state; the child only transports RPC.
use super::*;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};
const LIMIT: u64 = 2 * 1024 * 1024;
pub(super) struct Call {
    pub name: String,
    pub arguments: Value,
    pub reply: oneshot::Sender<AppResult<Value>>,
}
pub(super) struct Bridge {
    pub configuration: Value,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Bridge {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Bridge {
    pub(super) async fn start() -> AppResult<(Self, mpsc::Receiver<Call>)> {
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
        let address = listener.local_addr()?;
        let token = id();
        let executable = std::env::current_exe()?;
        #[cfg(test)]
        let executable = std::env::var_os("REVIEWBOX_TEST_MCP_EXE")
            .map(PathBuf::from)
            .unwrap_or(executable);
        let config = json!({"command":executable,"args":["preparation-mcp",address.to_string()],"env":{"REVIEWBOX_SESSION_TOKEN":token},"enabled":true});
        let (sender, receiver) = mpsc::channel::<Call>(8);
        let task = tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                // One connection per RPC; serialize to keep mutations ordered and bounded.
                let mut socket = BufReader::new(socket);
                let mut bytes = Vec::new();
                use tokio::io::AsyncReadExt;
                let read = tokio::time::timeout(
                    std::time::Duration::from_secs(10),
                    (&mut socket).take(LIMIT + 1).read_until(b'\n', &mut bytes),
                )
                .await;
                if !matches!(read, Ok(Ok(_))) || bytes.len() as u64 > LIMIT {
                    continue;
                }
                let Ok(request) = serde_json::from_slice::<Value>(&bytes) else {
                    continue;
                };
                if request["token"].as_str() != Some(&token) {
                    continue;
                }
                let (reply, response) = oneshot::channel();
                if sender
                    .send(Call {
                        name: request["name"].as_str().unwrap_or_default().into(),
                        arguments: request["arguments"].clone(),
                        reply,
                    })
                    .await
                    .is_err()
                {
                    break;
                }
                let result = match response.await {
                    Ok(Ok(value)) => {
                        json!({"content":[{"type":"text","text":value.to_string()}],"structuredContent":value,"isError":false})
                    }
                    Ok(Err(error)) => {
                        json!({"content":[{"type":"text","text":error.message}],"isError":true})
                    }
                    Err(_) => break,
                };
                if let Ok(mut bytes) = serde_json::to_vec(&result) {
                    bytes.push(b'\n');
                    let _ = socket.get_mut().write_all(&bytes).await;
                }
            }
        });
        Ok((
            Self {
                configuration: config,
                task,
            },
            receiver,
        ))
    }
}
fn inline_schema(schema: schemars::Schema) -> Value {
    fn expand(value: &Value, definitions: &Value) -> Value {
        if let Some(reference) = value
            .get("$ref")
            .and_then(Value::as_str)
            .and_then(|s| s.strip_prefix("#/$defs/"))
        {
            return expand(&definitions[reference], definitions);
        }
        match value {
            Value::Object(map) => map
                .iter()
                .filter(|(key, _)| key.as_str() != "$defs" && key.as_str() != "$schema")
                .map(|(key, value)| (key.clone(), expand(value, definitions)))
                .collect::<serde_json::Map<_, _>>()
                .into(),
            Value::Array(items) => items
                .iter()
                .map(|v| expand(v, definitions))
                .collect::<Vec<_>>()
                .into(),
            _ => value.clone(),
        }
    }
    let value = serde_json::to_value(schema).unwrap_or_default();
    expand(&value, &value["$defs"])
}
fn tools() -> AppResult<Vec<Value>> {
    let descriptions = std::fs::read_to_string(
        crate::project_skills::cli_resources()?.join("preparation/tools.md"),
    )?;
    let descriptions: BTreeMap<_, _> = descriptions
        .split("\n## ")
        .skip(1)
        .filter_map(|section| {
            section
                .split_once('\n')
                .map(|(name, body)| (name.trim(), body.trim()))
        })
        .collect();
    let step = inline_schema(schemars::schema_for!(super::session::PlannedStep));
    let document = inline_schema(schemars::schema_for!(ReviewDocument));
    [
        ("review_state",json!({"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":200}}),vec![]),
        ("review_source",json!({"sourceId":{"type":"string"},"previous":{"type":"boolean"},"startLine":{"type":"integer","minimum":1},"lineCount":{"type":"integer","minimum":1,"maximum":1000}}),vec!["sourceId"]),
        ("review_read_document",json!({"stepId":{"type":"string"},"previous":{"type":"boolean"},"offset":{"type":"integer","minimum":0}}),vec!["stepId"]),
        ("review_search",json!({"query":{"type":"string"},"previous":{"type":"boolean"}}),vec!["query"]),
        ("review_context_assess",json!({"assessments":{"type":"array","items":inline_schema(schemars::schema_for!(WorkingContextAssessment))}}),vec!["assessments"]),
        ("review_activity",json!({"text":{"type":"string"},"stepId":{"type":"string"},"state":{"type":"string","enum":["planned","working","error"]}}),vec!["text"]),
        ("review_plan",json!({"steps":{"type":"array","items":step}}),vec!["steps"]),
        ("review_document",json!({"stepId":{"type":"string"},"document":document,"anchors":{"type":"array","items":inline_schema(schemars::schema_for!(CodeAnchor))},"contextSourceIds":{"type":"array","items":{"type":"string"}}}),vec!["stepId","document","anchors"]),
        ("review_decide",json!({"stepId":{"type":"string"},"decision":{"enum":["keep","remove"]}}),vec!["stepId","decision"]),
        ("review_finish",json!({"summary":{"type":"string"}}),vec!["summary"]),
    ].into_iter().map(|(name,mut properties,required)| {
        let description = descriptions.get(name).ok_or_else(||invalid("Missing preparation tool description."))?;
        let mutation = matches!(name,"review_plan"|"review_document"|"review_decide"|"review_finish");
        let mut required = required;
        if mutation { properties["requestId"] = json!({"type":"string"}); properties["revision"] = json!({"type":"integer","minimum":0}); required.extend(["requestId","revision"]); }
        Ok(json!({"name":name,"description":description,"inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false}}))
    }).collect()
}
pub(crate) fn proxy(address: &str) -> AppResult<()> {
    use std::io::{BufRead, Read, Write};
    let address: std::net::SocketAddr = address
        .parse()
        .map_err(|_| invalid("Invalid session address."))?;
    if !address.ip().is_loopback() {
        return Err(invalid("Session address must be local."));
    }
    let token =
        std::env::var("REVIEWBOX_SESSION_TOKEN").map_err(|_| invalid("Missing session token."))?;
    let mut input = std::io::stdin().lock();
    let mut output = std::io::stdout().lock();
    loop {
        let mut bytes = Vec::new();
        if (&mut input).take(LIMIT + 1).read_until(b'\n', &mut bytes)? == 0 {
            break;
        }
        if bytes.len() as u64 > LIMIT {
            return Err(invalid("MCP message exceeds 2 MiB."));
        }
        let request: Value = serde_json::from_slice(&bytes)?;
        let Some(id) = request.get("id") else {
            continue;
        };
        let result = match request["method"].as_str() {
            Some("initialize") => {
                json!({"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"reviewbox-preparation","version":"1"}})
            }
            Some("ping") => json!({}),
            Some("tools/list") => json!({"tools":tools()?}),
            Some("tools/call") => {
                let mut connection = std::net::TcpStream::connect_timeout(
                    &address,
                    std::time::Duration::from_secs(5),
                )?;
                connection.set_read_timeout(Some(std::time::Duration::from_secs(60)))?;
                writeln!(
                    connection,
                    "{}",
                    json!({"token":token,"name":request["params"]["name"],"arguments":request["params"]["arguments"]})
                )?;
                let mut bytes = Vec::new();
                std::io::BufReader::new(connection)
                    .take(LIMIT + 1)
                    .read_until(b'\n', &mut bytes)?;
                if bytes.len() as u64 > LIMIT {
                    return Err(invalid("MCP response exceeds 2 MiB."));
                }
                serde_json::from_slice(&bytes)?
            }
            _ => {
                writeln!(
                    output,
                    "{}",
                    json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Unknown method"}})
                )?;
                output.flush()?;
                continue;
            }
        };
        writeln!(
            output,
            "{}",
            json!({"jsonrpc":"2.0","id":id,"result":result})
        )?;
        output.flush()?;
    }
    Ok(())
}
