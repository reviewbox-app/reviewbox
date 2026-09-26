use crate::contracts::*;
use std::{collections::BTreeMap, fs, path::Path};

/// Single-pass substitution: injected source code is never parsed as a template.
pub fn render(template: &str, vars: &BTreeMap<String, String>) -> AppResult<String> {
    let mut out = String::new();
    let mut tail = template;
    while let Some(start) = tail.find("{{") {
        out.push_str(&tail[..start]);
        let rest = &tail[start + 2..];
        let end = rest
            .find("}}")
            .ok_or_else(|| AppError::new("invalid_template", "Unclosed prompt variable."))?;
        let key = &rest[..end];
        if key.is_empty() || !key.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_') {
            return Err(AppError::new(
                "invalid_template",
                "Prompt variables use letters, digits and underscores.",
            ));
        }
        out.push_str(vars.get(key).ok_or_else(|| {
            AppError::new(
                "missing_variable",
                format!("Missing prompt variable: {key}"),
            )
        })?);
        tail = &rest[end + 2..];
    }
    out.push_str(tail);
    Ok(out)
}
pub fn load(
    root: &Path,
    action: &str,
    vars: &BTreeMap<String, String>,
) -> AppResult<PromptPreview> {
    let skill = match action {
        "topics" | "ask" | "evidence" => "review",
        "file" | "block" | "glossary" | "refresh" => "explain",
        _ => return Err(AppError::new("unknown_action", "Unknown agent action.")),
    };
    let sources = vec![
        "system.md".to_string(),
        format!("skills/{skill}/SKILL.md"),
        format!("prompts/{action}.md"),
    ];
    let mut parts = Vec::new();
    for path in &sources {
        parts.push(render(&fs::read_to_string(root.join(path))?, vars)?);
    }
    let text = parts.join("\n\n");
    Ok(PromptPreview {
        action: action.into(),
        fingerprint: fingerprint(text.as_bytes()),
        text,
        sources,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn injection_is_literal() {
        let vars = BTreeMap::from([("code".into(), "const a = '{{secret}}'".into())]);
        assert_eq!(
            render("Read {{code}}", &vars).unwrap(),
            "Read const a = '{{secret}}'"
        );
    }
    #[test]
    fn missing_and_expressions_fail() {
        for text in ["{{missing}}", "{{a()}}", "{{broken"] {
            assert!(render(text, &BTreeMap::new()).is_err());
        }
    }
}

#[cfg(test)]
mod resource_tests {
    use super::*;
    #[test]
    fn every_shipped_action_is_loaded_from_markdown() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../resources/agents");
        let variables = BTreeMap::from([
            ("language".into(), "French".into()),
            ("snapshot_id".into(), "test".into()),
            ("request".into(), "A question".into()),
            ("context".into(), "let text = '{{unexpanded}}';".into()),
            ("schema".into(), "{}".into()),
        ]);
        for action in [
            "ask", "topics", "file", "block", "glossary", "refresh", "evidence",
        ] {
            let preview = load(&root, action, &variables).unwrap();
            assert_eq!(preview.sources.len(), 3);
            assert!(preview.text.contains("{{unexpanded}}"));
            assert_eq!(preview.fingerprint.len(), 64);
        }
        assert!(load(&root, "../../system", &variables).is_err());
    }
}
