//! Discover picker capabilities without starting a model turn or a persisted thread.
use super::*;
use serde_json::json;

#[cfg(test)]
mod tests;

#[derive(Default)]
pub struct CatalogManager(pub AgentManager);

pub(crate) fn for_project(mut config: ProviderConfig, project: ProjectSettings) -> ProviderConfig {
    if project
        .provider
        .as_deref()
        .is_none_or(|provider| provider == config.provider)
        && project.model.is_some()
    {
        config.model = project.model;
    }
    config
}

pub(super) fn default_model(provider: &str) -> Option<&'static str> {
    match provider {
        "codex" => Some("gpt-6.1-sol"),
        "claude" => Some("claude-sonnet-5"),
        _ => None,
    }
}

fn protocol_error() -> AppError {
    AppError::new(
        "model_catalog",
        "The harness returned an invalid model catalog. Try redetecting or updating it.",
    )
}

fn text(value: &Value, key: &str) -> AppResult<String> {
    value[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(protocol_error)
}

fn parse(items: &Value, provider: &str) -> AppResult<Vec<ProviderModel>> {
    items
        .as_array()
        .ok_or_else(protocol_error)?
        .iter()
        .filter(|item| provider != "codex" || item["hidden"] != true)
        // The picker already has a separate "Harness default" choice.
        .filter(|item| provider != "claude" || item["value"] != "default")
        .map(|item| {
            let efforts = if provider == "codex" {
                item["supportedReasoningEfforts"].as_array().map(|values| {
                    values
                        .iter()
                        .filter_map(|v| v["reasoningEffort"].as_str())
                        .map(str::to_owned)
                        .collect()
                })
            } else if item["supportsEffort"] == true {
                item["supportedEffortLevels"].as_array().map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
            } else {
                None
            };
            Ok(ProviderModel {
                id: text(
                    item,
                    if provider == "codex" {
                        "model"
                    } else {
                        "value"
                    },
                )?,
                resolved_model: item["resolvedModel"].as_str().map(str::to_owned),
                name: text(item, "displayName")?,
                description: item["description"].as_str().unwrap_or_default().into(),
                supported_efforts: efforts.unwrap_or_default(),
            })
        })
        .collect()
}

async fn codex_response(transport: &mut Transport, id: u32) -> AppResult<Value> {
    loop {
        let value = transport.next().await?;
        if value["id"] == id {
            if value.get("error").is_some() {
                return Err(protocol_error());
            }
            return Ok(value["result"].clone());
        }
        // Catalog discovery never approves requests or executes tools.
        if value.get("id").is_some() && value.get("method").is_some() {
            return Err(protocol_error());
        }
    }
}

async fn codex(transport: &mut Transport) -> AppResult<Vec<ProviderModel>> {
    transport
        .send(&json!({"id":1,"method":"initialize","params":{
            "clientInfo":{"name":"reviewbox","version":env!("CARGO_PKG_VERSION")}
        }}))
        .await?;
    codex_response(transport, 1).await?;
    transport
        .send(&json!({"method":"initialized","params":{}}))
        .await?;
    let mut models = Vec::new();
    let mut cursor = Value::Null;
    let mut seen = std::collections::HashSet::new();
    for id in 2..102 {
        transport
            .send(&json!({"id":id,"method":"model/list","params":{
                "includeHidden":false,"limit":100,"cursor":cursor
            }}))
            .await?;
        let response = codex_response(transport, id).await?;
        models.extend(parse(&response["data"], "codex")?);
        cursor = response["nextCursor"].clone();
        if cursor.is_null() {
            let mut ids = std::collections::HashSet::new();
            models.retain(|model| ids.insert(model.id.clone()));
            return Ok(models);
        }
        if !cursor.is_string() || !seen.insert(cursor.to_string()) {
            return Err(protocol_error());
        }
    }
    Err(protocol_error())
}

async fn claude(transport: &mut Transport) -> AppResult<Vec<ProviderModel>> {
    transport.send(&json!({"type":"control_request","request_id":"models","request":{"subtype":"initialize"}})).await?;
    loop {
        let value = transport.next().await?;
        if value["type"] == "control_response" && value["response"]["request_id"] == "models" {
            if value["response"]["subtype"] != "success" {
                return Err(protocol_error());
            }
            return parse(&value["response"]["response"]["models"], "claude");
        }
        if value["type"] == "control_request" || value["type"] == "result" {
            return Err(protocol_error());
        }
    }
}

pub(crate) async fn discover(
    config: &ProviderConfig,
    cancel: Arc<AtomicBool>,
) -> AppResult<Vec<ProviderModel>> {
    discover_with_timeout(config, cancel, Duration::from_secs(20)).await
}

async fn discover_with_timeout(
    config: &ProviderConfig,
    cancel: Arc<AtomicBool>,
    timeout: Duration,
) -> AppResult<Vec<ProviderModel>> {
    if cancel.load(Ordering::Relaxed) {
        return Err(AppError::new("cancelled", "Model discovery stopped."));
    }
    // A neutral working directory prevents project hooks/configuration from
    // participating in a settings read. Account authentication stays with the CLI.
    let directory = tempfile::tempdir()?;
    let mut command = providers::command(&providers::resolve_executable(&config.executable));
    command.current_dir(directory.path());
    match config.provider.as_str() {
        "codex" => {
            command.args(["app-server", "--listen", "stdio://", "-c", "mcp_servers={}"]);
        }
        "claude" => {
            command.args([
                "-p",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--verbose",
                "--no-session-persistence",
                "--safe-mode",
                "--strict-mcp-config",
                "--mcp-config",
                "{\"mcpServers\":{}}",
            ]);
        }
        _ => return Err(AppError::new("provider", "Unknown provider.")),
    }
    let mut transport = Transport::new(command, cancel)?;
    let result = tokio::time::timeout(timeout, async {
        if config.provider == "codex" {
            codex(&mut transport).await
        } else {
            claude(&mut transport).await
        }
    })
    .await
    .map_err(|_| {
        AppError::new(
            "model_catalog_timeout",
            "Model discovery timed out. Try again.",
        )
    });
    transport.finish().await;
    result?
}

/// One policy for coordination, writing, commit planning and delegated models.
pub(super) async fn effort(
    config: &ProviderConfig,
    cancel: Arc<AtomicBool>,
) -> AppResult<Option<&'static str>> {
    match discover(config, cancel).await {
        Ok(catalog) => Ok(Some(catalog_effort(&catalog, config.model.as_deref()))),
        Err(error) if error.code == "cancelled" => Err(error),
        Err(_) => Ok(Some("low")),
    }
}

pub(super) fn catalog_effort(catalog: &[ProviderModel], selected: Option<&str>) -> &'static str {
    let model = selected.filter(|m| !m.is_empty() && *m != "default");
    let found = catalog.iter().find(|m| {
        model.is_some_and(|id| {
            m.id == id || (m.resolved_model.as_deref() == Some(id) && !m.id.contains('['))
        })
    });
    found.map_or("low", |m| preferred_effort(&m.supported_efforts))
}

pub(super) fn preferred_effort(supported: &[String]) -> &'static str {
    if supported.iter().any(|e| e == "none") {
        "none"
    } else {
        "low"
    }
}

#[cfg(test)]
mod reasoning_tests {
    use super::*;
    #[test]
    fn none_is_preferred_and_low_is_always_the_fallback() {
        assert_eq!(
            preferred_effort(&["low".into(), "none".into(), "high".into()]),
            "none"
        );
        assert_eq!(
            preferred_effort(&["low".into(), "medium".into(), "high".into()]),
            "low"
        );
        assert_eq!(preferred_effort(&["high".into()]), "low");
        assert_eq!(preferred_effort(&[]), "low");
        assert_eq!(catalog_effort(&[], Some("unlisted")), "low");
        assert_eq!(catalog_effort(&[], None), "low");
    }
}
