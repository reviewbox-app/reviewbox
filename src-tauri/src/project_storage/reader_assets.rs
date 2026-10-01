use super::*;
const PART_LIMIT: usize = 8 * 1024 * 1024;
#[derive(Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pack {
    format: String,
    version: u32,
    review_id: String,
    preparation_id: String,
    entries: BTreeMap<String, Entry>,
}
#[derive(Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entry {
    file_id: String,
    part: Part,
}
#[derive(Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)] // Legacy fields are deserialized solely to read existing immutable packs.
enum Part {
    Document {
        #[serde(default, skip_serializing, rename = "pseudocodeSelected")]
        #[schemars(skip)]
        pseudocode_selected: Option<bool>,
        documents: Option<Box<LevelDocuments>>,
        #[serde(default, skip_serializing, rename = "pseudocodeSkipReason")]
        #[schemars(skip)]
        pseudocode_skip_reason: Option<String>,
    },
    #[serde(skip_serializing)]
    #[schemars(skip)]
    Translation {
        #[serde(rename = "sourceId")]
        source_id: String,
        #[serde(rename = "sourceHash")]
        source_hash: String,
        #[serde(rename = "unavailableReason")]
        unavailable_reason: Option<String>,
    },
    #[serde(skip_serializing)]
    #[schemars(skip)]
    Block {
        #[serde(rename = "sourceId")]
        source_id: String,
        index: u32,
        block: Value,
    },
}
#[derive(Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct Location {
    path: String,
    hash: String,
}
pub(crate) fn prepare(
    project: &Project,
    review_id: &str,
    preparation_id: &str,
    entries: Vec<ReviewFileContent>,
) -> AppResult<(Value, Files)> {
    identifier(review_id)?;
    identifier(preparation_id)?;
    let mut pieces = BTreeMap::new();
    let mut seen = std::collections::HashSet::new();
    for entry in entries {
        identifier(&entry.file_id)?;
        if !seen.insert(entry.file_id.clone()) {
            return Err(AppError::new(
                "duplicate_asset",
                "A file artifact occurs twice.",
            ));
        }
        let key = entry.file_id;
        pieces.insert(
            format!("{key}/document"),
            Entry {
                file_id: key.clone(),
                part: Part::Document {
                    pseudocode_selected: None,
                    documents: entry.documents.map(Box::new),
                    pseudocode_skip_reason: None,
                },
            },
        );
    }
    let mut packs = Files::new();
    let mut index: BTreeMap<String, Vec<Location>> = BTreeMap::new();
    let mut pack = Pack {
        format: "reviewbox".into(),
        version: VERSION,
        review_id: review_id.into(),
        preparation_id: preparation_id.into(),
        entries: BTreeMap::new(),
    };
    let flush = |pack: &mut Pack,
                 packs: &mut Files,
                 index: &mut BTreeMap<String, Vec<Location>>|
     -> AppResult<()> {
        if pack.entries.is_empty() {
            return Ok(());
        }
        let path = format!(
            "generated/{review_id}/{preparation_id}/{:04}.json",
            packs.len() + 1
        );
        checked(&project.root, &path)?;
        let content = bytes(pack)?;
        if content.len() > PART_LIMIT {
            return Err(AppError::new(
                "artifact_limit",
                "Generated asset part exceeds 8 MiB.",
            ));
        }
        let hash = fingerprint(&content);
        let file_ids: std::collections::BTreeSet<_> =
            pack.entries.values().map(|v| v.file_id.clone()).collect();
        for file in file_ids {
            index.entry(file).or_default().push(Location {
                path: path.clone(),
                hash: hash.clone(),
            });
        }
        packs.insert(path, content);
        pack.entries.clear();
        Ok(())
    };
    // Reserve a small constant for the envelope and indentation, then count each
    // pretty-printed entry with its key. An individual document/block is bounded
    // by the provider contract; a collection can span multiple parts.
    let mut size = bytes(&pack)?.len();
    for (key, entry) in pieces {
        let encoded = bytes(&entry)?;
        let entry_size =
            encoded.len() + encoded.iter().filter(|b| **b == b'\n').count() * 4 + key.len() + 32;
        if size + entry_size > PART_LIMIT {
            flush(&mut pack, &mut packs, &mut index)?;
            size = bytes(&pack)?.len();
        }
        if size + entry_size > PART_LIMIT {
            return Err(AppError::new(
                "artifact_limit",
                "One generated document or block exceeds 8 MiB.",
            ));
        }
        size += entry_size;
        pack.entries.insert(key, entry);
    }
    flush(&mut pack, &mut packs, &mut index)?;
    Ok((serde_json::to_value(index)?, packs))
}
pub(crate) fn read(
    root: &Path,
    review_id: &str,
    preparation_id: &str,
    file_id: &str,
    index: &Value,
) -> AppResult<ReviewFileContent> {
    let locations: Vec<Location> =
        serde_json::from_value(index.get(file_id).cloned().ok_or_else(|| {
            AppError::new("not_found", "This file has no generated document yet.")
        })?)?;
    if locations.is_empty() {
        return Err(AppError::new(
            "missing_asset",
            "Generated document parts are missing.",
        ));
    }
    let mut entries = BTreeMap::new();
    let mut paths = std::collections::HashSet::new();
    for location in locations {
        if !paths.insert(location.path.clone())
            || !location
                .path
                .starts_with(&format!("generated/{review_id}/{preparation_id}/"))
        {
            return Err(AppError::new(
                "invalid_asset",
                "Generated file belongs to another preparation or repeats a part.",
            ));
        }
        let path = checked(root, &location.path)?;
        if fs::metadata(&path)?.len() > PART_LIMIT as u64 {
            return Err(AppError::new(
                "artifact_limit",
                "Generated file exceeds 8 MiB.",
            ));
        }
        let content = fs::read(path)?;
        if fingerprint(&content) != location.hash {
            return Err(AppError::new(
                "corrupt_asset",
                "Generated document hash does not match.",
            ));
        }
        let pack: Pack = serde_json::from_slice(&content)?;
        if pack.format != "reviewbox"
            || pack.version != VERSION
            || pack.review_id != review_id
            || pack.preparation_id != preparation_id
        {
            return Err(AppError::new(
                "invalid_asset",
                "Generated document belongs to another review.",
            ));
        }
        let mut found = false;
        for (key, entry) in pack.entries {
            if entry.file_id != file_id {
                continue;
            }
            found = true;
            if entries.insert(key, entry.part).is_some() {
                return Err(AppError::new(
                    "invalid_asset",
                    "Generated document has duplicated blocks.",
                ));
            }
        }
        if !found {
            return Err(AppError::new(
                "missing_asset",
                "Generated part has no entries for this file.",
            ));
        }
    }
    let mut documents = None;
    let mut has_document = false;
    for (_, part) in entries {
        if let Part::Document {
            documents: value, ..
        } = part
        {
            if has_document {
                return Err(AppError::new(
                    "invalid_asset",
                    "Generated document is duplicated.",
                ));
            }
            has_document = true;
            documents = value.map(|documents| *documents);
        }
    }
    if !has_document {
        return Err(AppError::new(
            "missing_asset",
            "Generated file document header is missing.",
        ));
    }
    Ok(ReviewFileContent {
        file_id: file_id.into(),
        documents,
    })
}
pub(crate) fn schema() -> Value {
    let mut schema =
        serde_json::to_value(schemars::schema_for!(Pack)).expect("generated asset schema");
    schema["properties"]["version"] = json!({"const":VERSION});
    schema["properties"]["format"] = json!({"const":"reviewbox"});
    schema
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_translation_packs_are_read_without_rewriting_or_reemitting_them() {
        let dir = tempfile::tempdir().unwrap();
        let project = Project::open(dir.path(), "repo").unwrap();
        let path = "generated/review/prep/0001.json";
        let old = json!({"format":"reviewbox","version":VERSION,"reviewId":"review","preparationId":"prep","entries":{
            "file/document":{"fileId":"file","part":{"kind":"document","documents":null,"pseudocodeSelected":true,"pseudocodeSkipReason":null}},
            "file/translation/0/header":{"fileId":"file","part":{"kind":"translation","sourceId":"change:one:after","sourceHash":"hash","unavailableReason":null}},
            "file/translation/0/block/0":{"fileId":"file","part":{"kind":"block","sourceId":"change:one:after","index":0,"block":{"startLine":1,"endLine":1,"text":"RETURN value"}}}
        }});
        let content = bytes(&old).unwrap();
        let full_path = checked(&project.root, path).unwrap();
        fs::create_dir_all(full_path.parent().unwrap()).unwrap();
        fs::write(&full_path, &content).unwrap();
        let index = json!({"file":[{"path":path,"hash":fingerprint(&content)}]});
        let restored = read(&project.root, "review", "prep", "file", &index).unwrap();
        assert_eq!(
            serde_json::to_value(&restored).unwrap(),
            json!({"fileId":"file","documents":null})
        );
        assert_eq!(fs::read(&full_path).unwrap(), content);
        let (_, new_packs) = prepare(&project, "review", "next", vec![restored]).unwrap();
        for bytes in new_packs.values() {
            let text = String::from_utf8_lossy(bytes);
            assert!(!text.contains("translation"));
            assert!(!text.contains("pseudocode"));
        }
        fs::write(&full_path, b"corrupt").unwrap();
        assert_eq!(
            read(&project.root, "review", "prep", "file", &index)
                .unwrap_err()
                .code,
            "corrupt_asset"
        );
    }

    #[test]
    fn legacy_file_content_accepts_only_known_retired_fields() {
        let old = json!({"fileId":"file","documents":null,"translations":[{"blocks":[]}],"pseudocodeSelected":true,"pseudocodeSkipReason":null});
        let value: ReviewFileContent = serde_json::from_value(old.clone()).unwrap();
        assert_eq!(
            serde_json::to_value(value).unwrap(),
            json!({"fileId":"file","documents":null})
        );
        let mut unknown = old;
        unknown["unexpected"] = json!(true);
        assert!(serde_json::from_value::<ReviewFileContent>(unknown).is_err());
    }
}
