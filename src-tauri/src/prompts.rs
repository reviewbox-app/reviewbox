use crate::contracts::*;
use std::collections::BTreeMap;

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
