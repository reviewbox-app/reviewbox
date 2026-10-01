//! Disposable Git archive copies; durable publications never enter this cache.
use super::*;
use std::collections::BTreeSet;

pub(super) const LIMIT: u64 = 512 * 1024 * 1024;

#[derive(Default, Serialize, Deserialize)]
struct Ledger {
    clock: u64,
    access: BTreeMap<String, u64>,
}
struct Entry {
    path: String,
    size: u64,
    snapshots: BTreeSet<String>,
}

fn cache_path(project: &Project, review: &str, hash: &str) -> AppResult<(String, PathBuf)> {
    identifier(review)?;
    if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(AppError::new(
            "invalid_archive_cache",
            "Invalid archive cache identity.",
        ));
    }
    let path = format!(".local/archives/{review}/{hash}");
    Ok((path.clone(), checked(&project.root, &path)?))
}

fn size(root: &Path) -> AppResult<u64> {
    let mut total = 0u64;
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = checked(root, &entry.file_name().to_string_lossy())?;
        let metadata = fs::symlink_metadata(&path)?;
        total = total.saturating_add(if metadata.is_dir() {
            size(&path)?
        } else {
            metadata.len()
        });
    }
    Ok(total)
}

pub(super) fn collect(
    project: &Project,
    current: &Path,
    protected: &BTreeSet<String>,
    limit: u64,
) -> AppResult<()> {
    let ledger_path = checked(&project.root, ".local/archive-cache.json")?;
    let mut ledger: Ledger = fs::read(&ledger_path)
        .ok()
        .and_then(|data| serde_json::from_slice(&data).ok())
        .unwrap_or_default();
    let mut entries = Vec::new();
    let root = checked(&project.root, ".local/archives")?;
    if !root.exists() {
        return Ok(());
    }
    // Rebuild the disk inventory every time: crashes and manual cache removal
    // cannot leave unaccounted files outside the byte budget.
    for review in fs::read_dir(root)? {
        let review = review?;
        let id = review.file_name().to_string_lossy().into_owned();
        identifier(&id)?;
        let directory = checked(&project.root, &format!(".local/archives/{id}"))?;
        for hash in fs::read_dir(directory)? {
            let hash = hash?.file_name().to_string_lossy().into_owned();
            let (path, directory) = cache_path(project, &id, &hash)?;
            if !directory.is_dir() {
                return Err(AppError::new(
                    "invalid_archive_cache",
                    "Unexpected archive cache file.",
                ));
            }
            let mut snapshots = BTreeSet::new();
            let source_directory = checked(&directory, "snapshots")?;
            if source_directory.exists() {
                for source in fs::read_dir(source_directory)? {
                    let name = source?.file_name().to_string_lossy().into_owned();
                    if let Some(id) = name.strip_suffix(".json") {
                        snapshots.insert(id.to_string());
                    }
                }
            }
            if directory == current {
                ledger.clock = ledger.clock.saturating_add(1);
                ledger.access.insert(path.clone(), ledger.clock);
            }
            entries.push(Entry {
                path,
                size: size(&directory)?,
                snapshots,
            });
        }
    }
    ledger
        .access
        .retain(|path, _| entries.iter().any(|entry| &entry.path == path));
    entries.sort_by_key(|entry| {
        (
            ledger.access.get(&entry.path).copied().unwrap_or(0),
            entry.path.clone(),
        )
    });
    let mut total = entries.iter().map(|entry| entry.size).sum::<u64>();
    for entry in entries {
        if total <= limit {
            break;
        }
        let directory = checked(&project.root, &entry.path)?;
        if directory == current || !entry.snapshots.is_disjoint(protected) {
            continue;
        }
        fs::remove_dir_all(&directory)?;
        ledger.access.remove(&entry.path);
        total = total.saturating_sub(entry.size);
    }
    atomic(&ledger_path, &bytes(&ledger)?)
}
