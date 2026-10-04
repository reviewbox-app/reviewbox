use regex::Regex;
use std::sync::LazyLock;

static SECRETS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    #[derive(serde::Deserialize)]
    struct Rule {
        pattern: String,
        flags: String,
    }
    let rules: Vec<Rule> = serde_json::from_str(include_str!(
        "../../../resources/diagnostics/redaction.json"
    ))
    .expect("bundled diagnostic redaction rules");
    rules
        .into_iter()
        .map(|rule| {
            regex::RegexBuilder::new(&rule.pattern)
                .case_insensitive(rule.flags.contains('i'))
                .dot_matches_new_line(rule.flags.contains('s'))
                .build()
                .expect("static diagnostic redaction pattern")
        })
        .collect()
});

pub(crate) fn redact(text: &str, limit: usize) -> String {
    let mut value: String = text
        .chars()
        .take(65_536)
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
        .collect();
    for regex in SECRETS.iter() {
        value = regex.replace_all(&value, "[redacted]").into_owned();
    }
    if value.chars().count() > limit {
        value = value.chars().take(limit).collect();
        value.push_str("\n[truncated]");
    }
    value
}
