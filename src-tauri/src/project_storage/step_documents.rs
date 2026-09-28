//! Bounded shared step documents, hydrated only for an explicit review read.
use super::*;

const PART_LIMIT: usize = 8 * 1024 * 1024;

#[derive(Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pack {
    format: String,
    version: u32,
    review_id: String,
    documents: BTreeMap<String, LevelDocuments>,
}

#[derive(Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct Reference {
    path: String,
    hash: String,
}

fn steps(value: &mut Value) -> impl Iterator<Item = &mut Value> {
    value["topics"]
        .as_array_mut()
        .into_iter()
        .flatten()
        .flat_map(|topic| topic["steps"].as_array_mut().into_iter().flatten())
}

fn review_id(value: &Value) -> AppResult<String> {
    let id = value["id"]
        .as_str()
        .ok_or_else(|| AppError::new("invalid_asset", "Review identity is missing."))?;
    identifier(id)?;
    Ok(id.into())
}

fn reference(review: &str, value: &Value) -> AppResult<Reference> {
    let reference: Reference = serde_json::from_value(value.clone())?;
    if reference.path != format!("generated/{review}/steps/{}.json", reference.hash)
        || reference.hash.len() != 64
        || !reference
            .hash
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    {
        return Err(AppError::new(
            "invalid_asset",
            "Step documents belong to another review or have an invalid hash.",
        ));
    }
    Ok(reference)
}

/// Replaces inline variants with immutable locations before the project journal
/// publishes the review/topic/history metadata that references them.
pub(crate) fn extract(value: &mut Value) -> AppResult<Files> {
    let review_id = review_id(value)?;
    let mut documents = BTreeMap::new();
    for step in steps(value) {
        let id = step["id"]
            .as_str()
            .ok_or_else(|| AppError::new("invalid_asset", "Step identity is missing."))?;
        identifier(id)?;
        if let Some(inline) = step.get("documents") {
            if documents
                .insert(
                    id.to_owned(),
                    serde_json::from_value::<LevelDocuments>(inline.clone())?,
                )
                .is_some()
            {
                return Err(AppError::new(
                    "invalid_asset",
                    "Duplicate step document identity.",
                ));
            }
        } else {
            reference(&review_id, &step["documentAsset"])?;
        }
    }
    let mut pack = Pack {
        format: "reviewbox".into(),
        version: VERSION,
        review_id,
        documents: BTreeMap::new(),
    };
    let mut locations = BTreeMap::new();
    let mut files = Files::new();
    let flush = |pack: &mut Pack,
                 locations: &mut BTreeMap<String, Reference>,
                 files: &mut Files|
     -> AppResult<()> {
        if pack.documents.is_empty() {
            return Ok(());
        }
        let content = bytes(pack)?;
        if content.len() > PART_LIMIT {
            return Err(AppError::new(
                "artifact_limit",
                "Step document part exceeds 8 MiB.",
            ));
        }
        let hash = fingerprint(&content);
        let path = format!("generated/{}/steps/{hash}.json", pack.review_id);
        for id in pack.documents.keys() {
            locations.insert(
                id.clone(),
                Reference {
                    path: path.clone(),
                    hash: hash.clone(),
                },
            );
        }
        files.insert(path, content);
        pack.documents.clear();
        Ok(())
    };
    let mut size = bytes(&pack)?.len();
    for (id, document) in documents {
        let content = bytes(&document)?;
        let entry_size =
            content.len() + content.iter().filter(|c| **c == b'\n').count() * 4 + id.len() + 32;
        if size + entry_size > PART_LIMIT {
            flush(&mut pack, &mut locations, &mut files)?;
            size = bytes(&pack)?.len();
        }
        if size + entry_size > PART_LIMIT {
            return Err(AppError::new(
                "artifact_limit",
                "One step document exceeds 8 MiB.",
            ));
        }
        size += entry_size;
        pack.documents.insert(id, document);
    }
    flush(&mut pack, &mut locations, &mut files)?;
    for step in steps(value) {
        if let Some(location) = step["id"].as_str().and_then(|id| locations.get(id)) {
            let object = step
                .as_object_mut()
                .ok_or_else(|| AppError::new("invalid_asset", "Invalid step metadata."))?;
            object.remove("documents");
            object.insert("documentAsset".into(), serde_json::to_value(location)?);
        }
    }
    Ok(files)
}

/// Structural validation does not read generated assets during a project scan.
pub(crate) fn validation_value(value: &Value) -> AppResult<Value> {
    let review = review_id(value)?;
    let mut result = value.clone();
    for step in steps(&mut result) {
        if step.get("documents").is_some() {
            return Err(AppError::new(
                "invalid_asset",
                "Step documents must use their grouped asset reference.",
            ));
        }
        reference(&review, &step["documentAsset"])?;
        let empty = json!({"body":"","references":[],"terms":[],"readingSeconds":0});
        step["documents"] = json!({"beginner":empty,"intermediate":empty,"developer":empty});
    }
    Ok(result)
}

pub(crate) fn hydrate(root: &Path, value: &mut Value) -> AppResult<()> {
    let review = review_id(value)?;
    let mut loaded = BTreeMap::<String, Pack>::new();
    for step in steps(value) {
        let location = reference(&review, &step["documentAsset"])?;
        if !loaded.contains_key(&location.path) {
            let path = checked(root, &location.path)?;
            if fs::metadata(&path)?.len() > PART_LIMIT as u64 {
                return Err(AppError::new(
                    "artifact_limit",
                    "Step document part exceeds 8 MiB.",
                ));
            }
            let content = fs::read(path)?;
            if fingerprint(&content) != location.hash {
                return Err(AppError::new(
                    "corrupt_asset",
                    "Step document hash does not match.",
                ));
            }
            let pack: Pack = serde_json::from_slice(&content)?;
            if pack.format != "reviewbox" || pack.version != VERSION || pack.review_id != review {
                return Err(AppError::new(
                    "invalid_asset",
                    "Step documents belong to another review.",
                ));
            }
            loaded.insert(location.path.clone(), pack);
        }
        let document = step["id"]
            .as_str()
            .and_then(|id| loaded[&location.path].documents.get(id))
            .ok_or_else(|| {
                AppError::new(
                    "missing_asset",
                    "The step document is absent from its referenced part.",
                )
            })?;
        step["documents"] = serde_json::to_value(document)?;
        step.as_object_mut().unwrap().remove("documentAsset");
    }
    Ok(())
}

pub(crate) fn schema() -> Value {
    let mut schema = serde_json::to_value(schemars::schema_for!(Pack)).expect("step asset schema");
    schema["properties"]["format"] = json!({"const":"reviewbox"});
    schema["properties"]["version"] = json!({"const":VERSION});
    schema
}

pub(crate) fn reference_schema() -> Value {
    json!({"type":"object","additionalProperties":false,"required":["path","hash"],"properties":{"path":{"type":"string"},"hash":{"type":"string","pattern":"^[a-f0-9]{64}$"}}})
}
