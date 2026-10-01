//! Disposable source-byte cache. Captures hold a lease until their source packs
//! are durable; readers receive owned bytes before any entry can be evicted.
use crate::contracts::{AppError, AppResult, fingerprint};
use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub(crate) const SOURCE_CACHE_LIMIT: u64 = 512 * 1024 * 1024;
const CONTENT_LIMIT: usize = 64 * 1024 * 1024;

#[derive(Clone)]
struct Entry {
    size: u64,
    accessed: SystemTime,
}

#[derive(Default)]
struct State {
    entries: BTreeMap<String, Entry>,
    leases: usize,
    latest: Option<SystemTime>,
}

pub(crate) struct SourceCache {
    root: PathBuf,
    limit: u64,
    state: Mutex<State>,
}

pub(crate) struct SourceCacheLease(Arc<SourceCache>);

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct CacheStats {
    pub removed_files: usize,
    pub removed_bytes: u64,
    pub remaining_bytes: u64,
}

fn valid_hash(hash: &str) -> AppResult<()> {
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::new(
            "invalid_hash",
            "Invalid source cache identifier.",
        ));
    }
    Ok(())
}

impl SourceCache {
    pub(crate) fn open(root: PathBuf, limit: u64) -> AppResult<Self> {
        fs::create_dir_all(&root)?;
        let mut state = State::default();
        for entry in fs::read_dir(&root)? {
            let entry = entry?;
            let hash = entry.file_name().to_string_lossy().into_owned();
            if valid_hash(&hash).is_err() {
                // Storage calls open only after acquiring its exclusive owner
                // lock. Remove only this cache writer's interrupted temporary
                // files, retaining unknown files rather than guessing ownership.
                let ours = hash.starts_with(".tmp")
                    || hash
                        .strip_prefix('.')
                        .is_some_and(|name| uuid::Uuid::parse_str(name).is_ok());
                if ours && entry.file_type()?.is_file() {
                    fs::remove_file(entry.path())?;
                }
                continue;
            }
            let metadata = fs::symlink_metadata(entry.path())?;
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err(AppError::new(
                    "invalid_cache",
                    "A source cache entry is not a regular file.",
                ));
            }
            state.entries.insert(
                hash,
                Entry {
                    size: metadata.len(),
                    accessed: metadata
                        .accessed()
                        .or_else(|_| metadata.modified())
                        .unwrap_or(UNIX_EPOCH),
                },
            );
        }
        state.latest = state.entries.values().map(|entry| entry.accessed).max();
        Ok(Self {
            root,
            limit,
            state: Mutex::new(state),
        })
    }

    pub(crate) fn pin(self: &Arc<Self>) -> SourceCacheLease {
        self.state.lock().unwrap().leases += 1;
        SourceCacheLease(self.clone())
    }

    fn touch(&self, state: &mut State, hash: &str, size: u64) {
        let now = SystemTime::now();
        let accessed = state
            .latest
            .map_or(now, |previous| now.max(previous + Duration::from_nanos(1)));
        state.latest = Some(accessed);
        state.entries.insert(hash.into(), Entry { size, accessed });
        // Explicit atime updates preserve LRU ordering on restart even when the
        // filesystem uses noatime/relatime. Failure affects cache efficiency,
        // never the validity of an already verified source.
        if let Ok(file) = fs::File::open(self.root.join(hash)) {
            let _ = file.set_times(fs::FileTimes::new().set_accessed(accessed));
        }
    }

    pub(crate) fn store(&self, bytes: &[u8]) -> AppResult<String> {
        if bytes.len() > CONTENT_LIMIT {
            return Err(AppError::new(
                "content_limit",
                "Source exceeds the 64 MiB content limit.",
            ));
        }
        let hash = fingerprint(bytes);
        let mut state = self.state.lock().unwrap();
        let destination = self.root.join(&hash);
        match fs::symlink_metadata(&destination) {
            Ok(metadata) => {
                if !metadata.is_file() || metadata.file_type().is_symlink() {
                    return Err(AppError::new(
                        "invalid_cache",
                        "A source cache entry is not a regular file.",
                    ));
                }
                if metadata.len() != bytes.len() as u64
                    || fingerprint(&fs::read(&destination)?) != hash
                {
                    return Err(AppError::new(
                        "corrupt_blob",
                        "Stored content failed its integrity check.",
                    ));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                crate::project_storage::atomic(&destination, bytes)?;
            }
            Err(error) => return Err(error.into()),
        }
        self.touch(&mut state, &hash, bytes.len() as u64);
        self.collect_locked(&mut state)?;
        Ok(hash)
    }

    pub(crate) fn read(&self, hash: &str) -> AppResult<Vec<u8>> {
        valid_hash(hash)?;
        let mut state = self.state.lock().unwrap();
        let path = self.root.join(hash);
        let metadata = fs::symlink_metadata(&path)?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() > CONTENT_LIMIT as u64
        {
            return Err(AppError::new(
                "invalid_cache",
                "Invalid source cache entry.",
            ));
        }
        let bytes = fs::read(path)?;
        if fingerprint(&bytes) != hash {
            return Err(AppError::new(
                "corrupt_blob",
                "Stored content failed its integrity check.",
            ));
        }
        self.touch(&mut state, hash, bytes.len() as u64);
        Ok(bytes)
    }

    pub(crate) fn collect(&self) -> AppResult<CacheStats> {
        self.collect_locked(&mut self.state.lock().unwrap())
    }

    fn collect_locked(&self, state: &mut State) -> AppResult<CacheStats> {
        let mut result = CacheStats {
            remaining_bytes: state.entries.values().map(|entry| entry.size).sum(),
            ..CacheStats::default()
        };
        if state.leases > 0 || result.remaining_bytes <= self.limit {
            return Ok(result);
        }
        let mut entries: Vec<_> = state
            .entries
            .iter()
            .map(|(hash, entry)| (hash.clone(), entry.clone()))
            .collect();
        entries.sort_by(|(left_hash, left), (right_hash, right)| {
            left.accessed
                .cmp(&right.accessed)
                .then_with(|| left_hash.cmp(right_hash))
        });
        for (hash, entry) in entries {
            if result.remaining_bytes <= self.limit {
                break;
            }
            match fs::remove_file(self.root.join(&hash)) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            state.entries.remove(&hash);
            result.removed_files += 1;
            result.removed_bytes += entry.size;
            result.remaining_bytes = result.remaining_bytes.saturating_sub(entry.size);
        }
        Ok(result)
    }
}

impl Drop for SourceCacheLease {
    fn drop(&mut self) {
        let mut state = self.0.state.lock().unwrap();
        state.leases = state.leases.saturating_sub(1);
        // A completed authoritative transaction must not become a failure merely
        // because disposable-cache eviction failed. Explicit collect reports it.
        let _ = self.0.collect_locked(&mut state);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cache(limit: u64) -> (tempfile::TempDir, Arc<SourceCache>) {
        let dir = tempfile::tempdir().unwrap();
        let cache = Arc::new(SourceCache::open(dir.path().join("blobs"), limit).unwrap());
        (dir, cache)
    }

    #[test]
    fn evicts_least_recently_read_entries_and_keeps_returned_bytes_owned() {
        let (_dir, cache) = cache(8);
        let first = cache.store(b"aaaa").unwrap();
        let second = cache.store(b"bbbb").unwrap();
        let retained = cache.read(&first).unwrap();
        let third = cache.store(b"cccc").unwrap();
        assert_eq!(cache.collect().unwrap().remaining_bytes, 8);
        assert!(cache.read(&second).is_err());
        assert_eq!(cache.read(&first).unwrap(), retained);
        assert_eq!(cache.read(&third).unwrap(), b"cccc");
        cache.store(b"dddd").unwrap();
        cache.store(b"eeee").unwrap();
        assert_eq!(retained, b"aaaa");
    }

    #[test]
    fn all_concurrent_capture_leases_protect_not_yet_durable_content() {
        let (_dir, cache) = cache(4);
        let capture_a = cache.pin();
        let first = cache.store(b"aaaa").unwrap();
        let capture_b = cache.pin();
        let second = cache.store(b"bbbb").unwrap();
        assert_eq!(cache.collect().unwrap().remaining_bytes, 8);
        drop(capture_a);
        assert_eq!(cache.read(&first).unwrap(), b"aaaa");
        assert_eq!(cache.read(&second).unwrap(), b"bbbb");
        assert_eq!(cache.collect().unwrap().remaining_bytes, 8);
        drop(capture_b);
        assert_eq!(cache.collect().unwrap().remaining_bytes, 4);
        assert!(cache.read(&first).is_err());
        assert_eq!(cache.read(&second).unwrap(), b"bbbb");
    }

    #[test]
    fn restart_restores_lru_and_collects_preexisting_cache_without_migration() {
        let (dir, cache) = cache(12);
        let first = cache.store(b"aaaa").unwrap();
        let second = cache.store(b"bbbb").unwrap();
        let third = cache.store(b"cccc").unwrap();
        cache.read(&first).unwrap();
        // Distinct whole-second access times also exercise filesystems that do
        // not preserve subsecond timestamps.
        for (hash, seconds) in [(&second, 1), (&third, 2), (&first, 3)] {
            fs::File::open(cache.root.join(hash))
                .unwrap()
                .set_times(
                    fs::FileTimes::new().set_accessed(UNIX_EPOCH + Duration::from_secs(seconds)),
                )
                .unwrap();
        }
        drop(cache);
        let reopened = SourceCache::open(dir.path().join("blobs"), 8).unwrap();
        assert_eq!(
            reopened.collect().unwrap(),
            CacheStats {
                removed_files: 1,
                removed_bytes: 4,
                remaining_bytes: 8
            }
        );
        assert!(reopened.read(&second).is_err());
        assert_eq!(reopened.read(&first).unwrap(), b"aaaa");
        assert_eq!(reopened.read(&third).unwrap(), b"cccc");
    }

    #[test]
    fn invalid_paths_corruption_and_symlinks_are_never_accepted_as_sources() {
        let (_dir, cache) = cache(100);
        assert_eq!(cache.read("../source").unwrap_err().code, "invalid_hash");
        let hash = cache.store(b"correct").unwrap();
        fs::write(cache.root.join(&hash), b"changed").unwrap();
        assert_eq!(cache.read(&hash).unwrap_err().code, "corrupt_blob");
        assert_eq!(cache.store(b"correct").unwrap_err().code, "corrupt_blob");
        #[cfg(unix)]
        {
            fs::remove_file(cache.root.join(&hash)).unwrap();
            std::os::unix::fs::symlink("/etc/hosts", cache.root.join(&hash)).unwrap();
            assert_eq!(cache.read(&hash).unwrap_err().code, "invalid_cache");
        }
    }

    #[test]
    fn startup_removes_owned_interrupted_temporaries_only() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(".tmpInterrupted"), b"unfinished").unwrap();
        fs::write(
            dir.path().join(format!(".{}", uuid::Uuid::new_v4())),
            b"unfinished",
        )
        .unwrap();
        fs::write(dir.path().join("unknown.txt"), b"retain").unwrap();
        SourceCache::open(dir.path().into(), 8).unwrap();
        let remaining: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(remaining, vec![std::ffi::OsString::from("unknown.txt")]);
    }
}
