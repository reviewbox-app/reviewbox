//! Internal-only complete definitions; the final outline remains authoritative.
use serde_json::Value;
use std::{collections::BTreeMap, sync::Arc};

#[derive(Clone)]
pub(crate) struct OutlineItem {
    pub topic: usize,
    pub step: usize,
    pub value: Value,
    pub title: String,
    pub brief: String,
}
pub(crate) type OutlineObserver = Arc<dyn Fn(Vec<OutlineItem>) + Send + Sync>;

struct Frame {
    path: Vec<String>,
    start: usize,
    array: bool,
    index: usize,
    key: Option<String>,
    expecting_key: bool,
}
impl Frame {
    fn child(&self) -> Vec<String> {
        let mut path = self.path.clone();
        path.push(if self.array {
            self.index.to_string()
        } else {
            self.key.clone().unwrap_or_default()
        });
        path
    }
}
#[derive(Default)]
struct Decoder {
    scanned: usize,
    stack: Vec<Frame>,
    quote: Option<usize>,
    escaped: bool,
    items: BTreeMap<usize, String>,
    candidates: Vec<(usize, OutlineItem)>,
    parents: BTreeMap<(usize, usize), BTreeMap<String, String>>,
}
impl Decoder {
    fn path(&self) -> Vec<String> {
        self.stack.last().map(Frame::child).unwrap_or_default()
    }
    fn update(&mut self, text: &str) -> Vec<OutlineItem> {
        for (offset, byte) in text.as_bytes()[self.scanned..].iter().copied().enumerate() {
            let pos = self.scanned + offset;
            if let Some(start) = self.quote {
                if self.escaped {
                    self.escaped = false;
                } else if byte == b'\\' {
                    self.escaped = true;
                } else if byte == b'"' {
                    self.quote = None;
                    if let Ok(value) = serde_json::from_str::<String>(&text[start..=pos]) {
                        let path = self.path();
                        if let Some(frame) = self.stack.last_mut() {
                            if frame.expecting_key {
                                frame.key = Some(value);
                                frame.expecting_key = false;
                            } else if path.len() == 3
                                && path[0] == "items"
                                && path[2] == "id"
                                && let Ok(index) = path[1].parse()
                            {
                                self.items.insert(index, value);
                            } else if path.len() == 6
                                && path[0] == "items"
                                && path[2] == "result"
                                && path[3] == "topics"
                                && matches!(path[5].as_str(), "title" | "brief")
                                && let (Ok(item), Ok(topic)) = (path[1].parse(), path[4].parse())
                            {
                                self.parents
                                    .entry((item, topic))
                                    .or_default()
                                    .insert(path[5].clone(), value);
                            }
                        }
                    }
                }
                continue;
            }
            match byte {
                b'"' => self.quote = Some(pos),
                b'{' | b'[' => self.stack.push(Frame {
                    path: self.path(),
                    start: pos,
                    array: byte == b'[',
                    index: 0,
                    key: None,
                    expecting_key: byte == b'{',
                }),
                b',' => {
                    if let Some(frame) = self.stack.last_mut() {
                        if frame.array {
                            frame.index += 1;
                        } else {
                            frame.expecting_key = true;
                            frame.key = None;
                        }
                    }
                }
                b'}' | b']' => {
                    if let Some(frame) = self.stack.pop() {
                        let p = &frame.path;
                        if byte == b'}'
                            && p.len() == 7
                            && p[0] == "items"
                            && p[2] == "result"
                            && p[3] == "topics"
                            && p[5] == "steps"
                            && let (Ok(item), Ok(topic), Ok(step), Ok(value)) = (
                                p[1].parse(),
                                p[4].parse(),
                                p[6].parse(),
                                serde_json::from_str(&text[frame.start..=pos]),
                            )
                        {
                            self.candidates.push((
                                item,
                                OutlineItem {
                                    topic,
                                    step,
                                    value,
                                    title: String::new(),
                                    brief: String::new(),
                                },
                            ));
                        }
                    }
                }
                _ => {}
            }
        }
        self.scanned = text.len();
        if self
            .items
            .values()
            .filter(|id| id.as_str() == "outline")
            .count()
            != 1
        {
            return vec![];
        }
        self.candidates
            .iter()
            .filter(|(index, _)| self.items.get(index).is_some_and(|id| id == "outline"))
            .filter_map(|(index, item)| {
                let parent = self.parents.get(&(*index, item.topic))?;
                let mut item = item.clone();
                item.title = parent.get("title")?.clone();
                item.brief = parent.get("brief")?.clone();
                Some(item)
            })
            .collect()
    }
}

pub(super) struct Preview {
    observer: OutlineObserver,
    message: String,
    text: String,
    decoder: Decoder,
    emitted: Vec<Value>,
}
impl Preview {
    #[cfg(test)]
    pub(super) fn new(observer: OutlineObserver) -> Self {
        Self {
            observer,
            message: String::new(),
            text: String::new(),
            decoder: Decoder::default(),
            emitted: vec![],
        }
    }
    pub(super) fn update(&mut self, message: &str, text: &str) {
        if text.len() > 2 * 1024 * 1024 {
            return;
        }
        if self.message != message || !text.starts_with(&self.text) {
            self.decoder = Decoder::default();
            self.emitted.clear();
            (self.observer)(vec![]);
        }
        self.message = message.into();
        let items = self.decoder.update(text);
        let values: Vec<_> = items
            .iter()
            .map(|item| {
                serde_json::json!([item.topic, item.step, item.title, item.brief, item.value])
            })
            .collect();
        if values != self.emitted {
            self.emitted = values;
            (self.observer)(items);
        }
        self.text = text.into();
    }
}

// Structured-output providers commonly emit properties in schema order. Keep
// parent context before its step array on the wire without changing JSON map
// ordering (and therefore fingerprints) anywhere in persisted project data.
pub(super) fn schema_message(value: &Value) -> serde_json::Result<Vec<u8>> {
    struct Ordered<'a>(&'a Value);
    impl serde::Serialize for Ordered<'_> {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            use serde::ser::{SerializeMap, SerializeSeq};
            match self.0 {
                Value::Object(object) => {
                    let mut keys: Vec<_> = object.keys().collect();
                    if object.contains_key("title")
                        && object.contains_key("brief")
                        && object.contains_key("steps")
                    {
                        keys.sort_by_key(|key| (key.as_str() == "steps", *key));
                    }
                    let mut map = serializer.serialize_map(Some(keys.len()))?;
                    for key in keys {
                        map.serialize_entry(key, &Ordered(&object[key]))?;
                    }
                    map.end()
                }
                Value::Array(values) => {
                    let mut seq = serializer.serialize_seq(Some(values.len()))?;
                    for value in values {
                        seq.serialize_element(&Ordered(value))?;
                    }
                    seq.end()
                }
                value => value.serialize(serializer),
            }
        }
    }
    serde_json::to_vec(&Ordered(value))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn complete_steps_arrive_before_the_envelope_and_handle_escapes() {
        let mut topic = serde_json::json!({"items":[{"id":"outline","result":{"topics":[{"steps":[{"title":"é 🦀 \\\" } [","writingBrief":"Private"},{"title":"Second"}]}]}}]});
        let steps = topic["items"][0]["result"]["topics"][0]["steps"].take();
        let text = format!(
            r#"{{"items":[{{"id":"outline","result":{{"topics":[{{"title":"Parent","brief":"Context","steps":{steps}}}]}}}}]}}"#
        );
        let mut decoder = Decoder::default();
        let mut partial = String::new();
        let mut first_at = None;
        for c in text.chars() {
            partial.push(c);
            let items = decoder.update(&partial);
            if items.len() == 1 {
                first_at.get_or_insert(partial.len());
            }
        }
        assert!(first_at.unwrap() < text.len());
        let result = decoder.update(&text);
        assert_eq!(result.len(), 2);
        assert_eq!((result[1].topic, result[1].step), (0, 1));
        assert_eq!(result[0].value["writingBrief"], "Private");
    }
    #[test]
    fn parent_context_is_required_even_when_it_arrives_after_steps() {
        let mut decoder = Decoder::default();
        let prefix = r#"{"items":[{"id":"outline","result":{"topics":[{"steps":[{"title":"Ready"}],"title":"Parent""#;
        assert!(decoder.update(prefix).is_empty());
        let full = format!("{prefix},\"brief\":\"Required context\"}}]}}}}]}}");
        let items = decoder.update(&full);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "Parent");
        assert_eq!(items[0].brief, "Required context");
    }
    #[test]
    fn wire_schema_places_parent_metadata_before_step_array() {
        let schema = serde_json::json!({"properties":{"title":{"type":"string"},"brief":{"type":"string"},"steps":{"type":"array"}}});
        let text = String::from_utf8(schema_message(&schema).unwrap()).unwrap();
        assert!(text.find("\"title\"").unwrap() < text.find("\"steps\"").unwrap());
        assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), schema);
    }
    #[test]
    fn ignores_other_arrays_and_incomplete_steps_and_handles_id_after_result() {
        let mut decoder = Decoder::default();
        assert!(
            decoder
                .update(
                    r#"{"items":[{"id":"outline","result":{"topics":[{"steps":[{"title":"partial""#
                )
                .is_empty()
        );
        let mut decoder = Decoder::default();
        let text = r#"{"items":[{"result":{"topics":[{"title":"Parent","brief":"Context","steps":[{"title":"done"}]}]},"id":"outline"},{"id":"other","result":{"topics":[{"steps":[{"title":"wrong"}]}]}}]}"#;
        assert_eq!(decoder.update(text).len(), 1);
    }
}
