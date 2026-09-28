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
enum Part {
    Document {
        #[serde(default, rename = "pseudocodeSelected")]
        pseudocode_selected: Option<bool>,
        documents: Option<Box<LevelDocuments>>,
        #[serde(default, rename = "pseudocodeSkipReason")]
        pseudocode_skip_reason: Option<String>,
    },
    Translation {
        #[serde(rename = "sourceId")]
        source_id: String,
        #[serde(rename = "sourceHash")]
        source_hash: String,
        #[serde(rename = "unavailableReason")]
        unavailable_reason: Option<String>,
    },
    Block {
        #[serde(rename = "sourceId")]
        source_id: String,
        index: u32,
        block: PseudoBlock,
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
    for mut entry in entries {
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
                    pseudocode_selected: entry.pseudocode_selected,
                    documents: entry.documents.map(Box::new),
                    pseudocode_skip_reason: entry.pseudocode_skip_reason,
                },
            },
        );
        entry
            .translations
            .sort_by(|a, b| a.source_id.cmp(&b.source_id));
        for (t, translation) in entry.translations.into_iter().enumerate() {
            pieces.insert(
                format!("{key}/translation/{t:08}/header"),
                Entry {
                    file_id: key.clone(),
                    part: Part::Translation {
                        source_id: translation.source_id.clone(),
                        source_hash: translation.source_hash,
                        unavailable_reason: translation.unavailable_reason,
                    },
                },
            );
            for (b, block) in translation.blocks.into_iter().enumerate() {
                pieces.insert(
                    format!("{key}/translation/{t:08}/block/{b:08}"),
                    Entry {
                        file_id: key.clone(),
                        part: Part::Block {
                            source_id: translation.source_id.clone(),
                            index: b as u32,
                            block,
                        },
                    },
                );
            }
        }
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
    // by the provider contract; a whole translated file can span any number of parts.
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
    let mut pseudocode_skip_reason = None;
    let mut pseudocode_selected = None;
    let mut has_document = false;
    let mut translations: BTreeMap<String, PseudoTranslation> = BTreeMap::new();
    let mut blocks: BTreeMap<String, BTreeMap<u32, PseudoBlock>> = BTreeMap::new();
    for (_, part) in entries {
        match part {
            Part::Document {
                pseudocode_selected: selected,
                documents: value,
                pseudocode_skip_reason: reason,
            } => {
                if has_document {
                    return Err(AppError::new(
                        "invalid_asset",
                        "Generated document is duplicated.",
                    ));
                }
                has_document = true;
                documents = value.map(|documents| *documents);
                pseudocode_selected = selected;
                pseudocode_skip_reason = reason;
            }
            Part::Translation {
                source_id,
                source_hash,
                unavailable_reason,
            } => {
                if translations
                    .insert(
                        source_id.clone(),
                        PseudoTranslation {
                            source_id,
                            source_hash,
                            unavailable_reason,
                            blocks: vec![],
                        },
                    )
                    .is_some()
                {
                    return Err(AppError::new(
                        "invalid_asset",
                        "Generated translation is duplicated.",
                    ));
                }
            }
            Part::Block {
                source_id,
                index,
                block,
            } => {
                if blocks
                    .entry(source_id)
                    .or_default()
                    .insert(index, block)
                    .is_some()
                {
                    return Err(AppError::new(
                        "invalid_asset",
                        "Generated block is duplicated.",
                    ));
                }
            }
        }
    }
    if !has_document {
        return Err(AppError::new(
            "missing_asset",
            "Generated file document header is missing.",
        ));
    }
    for (id, values) in blocks {
        let target = translations
            .get_mut(&id)
            .ok_or_else(|| AppError::new("missing_asset", "Translation header is missing."))?;
        for (expected, (index, block)) in values.into_iter().enumerate() {
            if index != expected as u32 {
                return Err(AppError::new(
                    "missing_asset",
                    "Translation block is missing.",
                ));
            }
            target.blocks.push(block);
        }
    }
    Ok(ReviewFileContent {
        pseudocode_selected,
        pseudocode_skip_reason,
        file_id: file_id.into(),
        documents,
        translations: translations.into_values().collect(),
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
    fn one_large_translation_spans_parts_and_reassembles_exactly() {
        let dir = tempfile::tempdir().unwrap();
        let project = Project::open(dir.path(), "repo").unwrap();
        let blocks: Vec<_> = (0..24)
            .map(|i| PseudoBlock {
                start_line: i + 1,
                end_line: i + 1,
                text: format!("{}-{i}", "a".repeat(512 * 1024)),
            })
            .collect();
        let content = ReviewFileContent {
            pseudocode_selected: None,
            pseudocode_skip_reason: None,
            file_id: "file-one".into(),
            documents: None,
            translations: vec![PseudoTranslation {
                source_id: "change:one:after".into(),
                source_hash: "sourcehash".into(),
                blocks,
                unavailable_reason: None,
            }],
        };
        let (index, packs) = prepare(&project, "review", "prep", vec![content.clone()]).unwrap();
        assert!(packs.len() > 1);
        assert!(packs.values().all(|b| b.len() <= PART_LIMIT));
        for (path, bytes) in &packs {
            let path = checked(&project.root, path).unwrap();
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, bytes).unwrap();
        }
        let restored = read(&project.root, "review", "prep", "file-one", &index).unwrap();
        assert_eq!(
            serde_json::to_value(restored).unwrap(),
            serde_json::to_value(content).unwrap()
        );
        let (_, again) = prepare(
            &project,
            "review",
            "prep",
            vec![
                serde_json::from_value(
                    serde_json::to_value(
                        read(&project.root, "review", "prep", "file-one", &index).unwrap(),
                    )
                    .unwrap(),
                )
                .unwrap(),
            ],
        )
        .unwrap();
        assert_eq!(packs, again);
        fs::write(
            checked(&project.root, packs.keys().last().unwrap()).unwrap(),
            b"corrupt",
        )
        .unwrap();
        assert_eq!(
            read(&project.root, "review", "prep", "file-one", &index)
                .unwrap_err()
                .code,
            "corrupt_asset"
        );
    }
}
