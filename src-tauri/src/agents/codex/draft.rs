use crate::contracts::AgentProgress;
use serde_json::Value;
use std::time::{Duration, Instant};

/// Incremental outline only. The complete response still uses the existing
/// proposal parser/validation; no partial JSON is published as a proposal.
pub(super) struct Draft {
    scanned: usize,
    characters: u32,
    depth: usize,
    quoted: bool,
    escaped: bool,
    topics_array: bool,
    object_start: Option<usize>,
    titles: Vec<String>,
    last_emit: Instant,
    emitted: bool,
}
impl Default for Draft {
    fn default() -> Self {
        Self {
            scanned: 0,
            characters: 0,
            depth: 0,
            quoted: false,
            escaped: false,
            topics_array: false,
            object_start: None,
            titles: vec![],
            last_emit: Instant::now(),
            emitted: false,
        }
    }
}
impl Draft {
    pub(super) fn update(&mut self, text: &str, force: bool) -> Option<AgentProgress> {
        let before = self.titles.len();
        self.characters += text[self.scanned..].chars().count() as u32;
        for (relative, byte) in text.as_bytes()[self.scanned..].iter().copied().enumerate() {
            let index = self.scanned + relative;
            if self.quoted {
                if self.escaped {
                    self.escaped = false;
                } else if byte == b'\\' {
                    self.escaped = true;
                } else if byte == b'"' {
                    self.quoted = false;
                }
                continue;
            }
            match byte {
                b'"' => self.quoted = true,
                b'[' | b'{' => {
                    if byte == b'[' && self.depth == 1 {
                        // Identify the root topics array without matching text
                        // that could occur inside prose, escaped strings or nested data.
                        let prefix = format!("{}]}}", &text[..=index]);
                        self.topics_array = serde_json::from_str::<Value>(&prefix)
                            .ok()
                            .is_some_and(|value| value["topics"].is_array());
                    }
                    if byte == b'{' && self.depth == 2 && self.topics_array {
                        self.object_start = Some(index);
                    }
                    self.depth += 1;
                }
                b']' | b'}' => {
                    if byte == b'}'
                        && self.depth == 3
                        && self.topics_array
                        && let Some(start) = self.object_start.take()
                        && let Ok(topic) = serde_json::from_str::<Value>(&text[start..=index])
                        && let Some(title) = topic["title"].as_str()
                        && self.titles.len() < 64
                    {
                        self.titles.push(title.chars().take(200).collect());
                    }
                    if byte == b']' && self.depth == 2 {
                        self.topics_array = false;
                    }
                    self.depth = self.depth.saturating_sub(1);
                }
                _ => {}
            }
        }
        self.scanned = text.len();
        if !force
            && self.emitted
            && before == self.titles.len()
            && self.last_emit.elapsed() < Duration::from_millis(250)
        {
            return None;
        }
        self.emitted = true;
        self.last_emit = Instant::now();
        Some(AgentProgress::Draft {
            characters: self.characters,
            topics: self.titles.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn streams_completed_topic_titles_across_unicode_and_escaped_delimiters() {
        let source = serde_json::json!({"kind":"topics","topics":[
            {"title":"Fichier é 🚀","brief":"ignore } \\\" [ braces", "steps":[]},
            {"title":"Next","steps":[{"title":"Not a topic"}]}
        ]})
        .to_string();
        let mut draft = Draft::default();
        let mut text = String::new();
        for character in source.chars() {
            text.push(character);
            draft.update(&text, false);
        }
        let result = serde_json::to_value(draft.update(&text, true).unwrap()).unwrap();
        assert_eq!(result["characters"], source.chars().count());
        assert_eq!(
            result["topics"],
            serde_json::json!(["Fichier é 🚀", "Next"])
        );
        assert_eq!(text, source);
    }
    #[test]
    fn excludes_incomplete_objects_and_other_arrays() {
        let mut draft = Draft::default();
        let result = draft
            .update(r#"{"topics":[{"title":"Incomplete""#, true)
            .unwrap();
        assert_eq!(
            serde_json::to_value(result).unwrap()["topics"],
            serde_json::json!([])
        );
        let result = Draft::default()
            .update(r#"{"sections":[{"title":"Not a topic"}]}"#, true)
            .unwrap();
        assert_eq!(
            serde_json::to_value(result).unwrap()["topics"],
            serde_json::json!([])
        );
    }
}
