//! LSP registrations are owned by the session and removed by their protocol ID.
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path};

pub(super) fn provider(method: &str) -> Option<&'static str> {
    let method = registration_method(method);
    Some(match method {
        "textDocument/completion" => "completionProvider",
        "textDocument/hover" => "hoverProvider",
        "textDocument/signatureHelp" => "signatureHelpProvider",
        "textDocument/definition" => "definitionProvider",
        "textDocument/references" => "referencesProvider",
        "textDocument/documentSymbol" => "documentSymbolProvider",
        "workspace/symbol" => "workspaceSymbolProvider",
        "textDocument/formatting" => "documentFormattingProvider",
        "textDocument/rename" => "renameProvider",
        "textDocument/codeAction" => "codeActionProvider",
        "textDocument/semanticTokens" => "semanticTokensProvider",
        "textDocument/diagnostic" => "diagnosticProvider",
        _ => return None,
    })
}
pub(super) fn registration_method(method: &str) -> &str {
    match method {
        "textDocument/semanticTokens/full" => "textDocument/semanticTokens",
        "textDocument/prepareRename" => "textDocument/rename",
        "completionItem/resolve" => "textDocument/completion",
        "codeAction/resolve" => "textDocument/codeAction",
        other => other,
    }
}
pub(super) fn supported(method: &str) -> bool {
    provider(method).is_some()
        || matches!(
            method,
            "workspace/didChangeWatchedFiles"
                | "workspace/didChangeConfiguration"
                | "workspace/didCreateFiles"
                | "workspace/didRenameFiles"
                | "workspace/didDeleteFiles"
        )
}
pub(super) fn effective(base: &Value, registrations: &BTreeMap<String, Value>) -> Value {
    let mut result = base.clone();
    if !result.is_object() {
        result = json!({});
    }
    for registration in registrations.values() {
        let method = registration["method"].as_str().unwrap_or_default();
        if let Some(key) = provider(method) {
            result[key] = registration
                .get("registerOptions")
                .filter(|v| v.is_object())
                .cloned()
                .unwrap_or_else(|| json!({}));
        } else if let Some(operation) = method
            .strip_prefix("workspace/")
            .and_then(|v| v.strip_suffix("Files"))
            && matches!(operation, "didCreate" | "didRename" | "didDelete")
        {
            if !result["workspace"].is_object() {
                result["workspace"] = json!({});
            }
            if !result["workspace"]["fileOperations"].is_object() {
                result["workspace"]["fileOperations"] = json!({});
            }
            result["workspace"]["fileOperations"][operation] =
                registration["registerOptions"].clone();
        }
    }
    // Preserve selectors and registration options for per-document Monaco providers.
    result["reviewboxRegistrations"] = json!(registrations.values().collect::<Vec<_>>());
    result["reviewboxStaticCapabilities"] = base.clone();
    result
}
pub(super) fn document_matches(options: &Value, root: &Path, path: &Path, language: &str) -> bool {
    let Some(selectors) = options["documentSelector"].as_array() else {
        return true;
    };
    selectors.iter().any(|s| {
        s["scheme"].as_str().is_none_or(|v| v == "file")
            && s["language"].as_str().is_none_or(|v| v == language)
            && (s["pattern"].is_null() || matches_pattern(&s["pattern"], root, path))
    })
}
fn glob(pattern: &str, candidate: &str, case_sensitive: bool) -> bool {
    globset::GlobBuilder::new(pattern)
        .literal_separator(true)
        .case_insensitive(!case_sensitive)
        .build()
        .is_ok_and(|g| g.compile_matcher().is_match(candidate))
}
pub(super) fn matches_pattern(pattern: &Value, root: &Path, path: &Path) -> bool {
    if let Some(pattern) = pattern.as_str() {
        let absolute = path.to_string_lossy().replace('\\', "/");
        let relative = path
            .strip_prefix(root)
            .ok()
            .map(|p| p.to_string_lossy().replace('\\', "/"));
        return glob(pattern, &absolute, true) || relative.is_some_and(|p| glob(pattern, &p, true));
    }
    let base_uri = pattern["baseUri"]
        .as_str()
        .or_else(|| pattern["baseUri"]["uri"].as_str());
    let Some(base) = base_uri
        .and_then(|v| url::Url::parse(v).ok())
        .and_then(|u| u.to_file_path().ok())
    else {
        return false;
    };
    let Some(pattern) = pattern["pattern"].as_str() else {
        return false;
    };
    path.strip_prefix(base)
        .is_ok_and(|p| glob(pattern, &p.to_string_lossy().replace('\\', "/"), true))
}
pub(super) fn watches(
    registrations: &BTreeMap<String, Value>,
    fallback: &[String],
    root: &Path,
    path: &Path,
    kind: u32,
) -> bool {
    let bit = match kind {
        1 => 1,
        2 => 2,
        3 => 4,
        _ => return false,
    };
    let watched = registrations
        .values()
        .filter(|r| r["method"] == "workspace/didChangeWatchedFiles")
        .collect::<Vec<_>>();
    if watched.is_empty() {
        return path.starts_with(root)
            && fallback
                .iter()
                .any(|p| matches_pattern(&json!(p), root, path));
    }
    watched.iter().any(|r| {
        r["registerOptions"]["watchers"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|w| {
                w["kind"].as_u64().unwrap_or(7) & bit != 0
                    && matches_pattern(&w["globPattern"], root, path)
            })
    })
}
pub(super) fn file_operation(options: &Value, path: &Path, directory: Option<bool>) -> bool {
    options["filters"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|filter| {
            if filter["scheme"].as_str().is_some_and(|s| s != "file") {
                return false;
            }
            if filter["pattern"]["matches"]
                .as_str()
                .is_some_and(|m| directory.is_some_and(|directory| (m == "folder") != directory))
            {
                return false;
            }
            filter["pattern"]["glob"].as_str().is_some_and(|pattern| {
                glob(
                    pattern,
                    &path.to_string_lossy().replace('\\', "/"),
                    filter["pattern"]["options"]["ignoreCase"] != true,
                )
            })
        })
}
pub(super) fn supports_file_operation(
    base: &Value,
    registrations: &BTreeMap<String, Value>,
    name: &str,
    path: &Path,
    directory: Option<bool>,
) -> bool {
    file_operation(&base["workspace"]["fileOperations"][name], path, directory)
        || registrations.values().any(|registration| {
            registration["method"] == format!("workspace/{name}Files")
                && file_operation(&registration["registerOptions"], path, directory)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn watched_patterns_use_base_uri_kind_and_unregister() {
        let root = tempfile::tempdir().unwrap();
        let relative = json!({"baseUri":url::Url::from_directory_path(root.path()).unwrap(),"pattern":"src/**/*.rs"});
        let mut registrations = BTreeMap::from([(
            "rust".into(),
            json!({"id":"rust","method":"workspace/didChangeWatchedFiles","registerOptions":{"watchers":[{"globPattern":relative,"kind":5}]}}),
        )]);
        assert!(watches(
            &registrations,
            &[],
            root.path(),
            &root.path().join("src/main.rs"),
            1
        ));
        assert!(!watches(
            &registrations,
            &[],
            root.path(),
            &root.path().join("src/main.rs"),
            2
        ));
        assert!(!watches(
            &registrations,
            &[],
            root.path(),
            &root.path().join("other.ts"),
            1
        ));
        registrations.remove("rust");
        assert!(!watches(
            &registrations,
            &[],
            root.path(),
            &root.path().join("src/main.rs"),
            1
        ));
    }
    #[test]
    fn removing_dynamic_provider_restores_static_options() {
        let base = json!({"completionProvider":{"triggerCharacters":["."]}});
        let mut regs = BTreeMap::from([(
            "extra".into(),
            json!({"id":"extra","method":"textDocument/completion","registerOptions":{"triggerCharacters":[":"]}}),
        )]);
        assert_eq!(
            effective(&base, &regs)["completionProvider"]["triggerCharacters"],
            json!([":"])
        );
        regs.clear();
        assert_eq!(
            effective(&base, &regs)["completionProvider"],
            base["completionProvider"]
        );
    }
    #[test]
    fn all_file_operation_registrations_remain_active() {
        let regs = BTreeMap::from([
            (
                "first".into(),
                json!({"method":"workspace/didRenameFiles","registerOptions":{"filters":[{"scheme":"file","pattern":{"glob":"**/*.ts"}}]}}),
            ),
            (
                "second".into(),
                json!({"method":"workspace/didRenameFiles","registerOptions":{"filters":[{"scheme":"file","pattern":{"glob":"**/*.rs"}}]}}),
            ),
        ]);
        assert!(supports_file_operation(
            &json!({}),
            &regs,
            "didRename",
            Path::new("/repo/main.ts"),
            Some(false)
        ));
        assert!(supports_file_operation(
            &json!({}),
            &regs,
            "didRename",
            Path::new("/repo/main.rs"),
            Some(false)
        ));
        assert!(!supports_file_operation(
            &json!({}),
            &regs,
            "didCreate",
            Path::new("/repo/main.ts"),
            Some(false)
        ));
    }
}
