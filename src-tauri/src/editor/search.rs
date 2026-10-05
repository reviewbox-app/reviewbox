//! Bounded native search, streamed per caller and checkout; buffers replace disk text.
use crate::{contracts::*, storage::Storage};
use grep_matcher::Matcher;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::{SearcherBuilder, sinks::UTF8};
use std::{
    borrow::Cow,
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs::File,
    io::Read,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::{Notify, Semaphore};

const MAX_QUERY_BYTES: usize = 512;
const FILE_BYTES: u64 = 2 * 1024 * 1024;
const TOTAL_BYTES: u64 = 256 * 1024 * 1024;
const MATCHES: usize = 1_000;
const FILE_MATCHES: usize = 100;
const SCAN_ENTRIES: usize = 100_000;
type Owner = (String, String);
type Publish = Arc<dyn Fn(EditorSearchBatch) -> bool + Send + Sync>;
struct Request {
    id: String,
    cancelled: Arc<AtomicBool>,
}
#[derive(Default)]
struct Requests {
    current: BTreeMap<Owner, Request>,
    // Cancellation can cross IPC before a queued invocation registers.
    cancelled: VecDeque<(Owner, String)>,
}
#[derive(Clone)]
pub(crate) struct SearchState {
    requests: Arc<Mutex<Requests>>,
    workers: Arc<Semaphore>,
    changed: Arc<Notify>,
}
impl Default for SearchState {
    fn default() -> Self {
        Self {
            requests: Arc::default(),
            workers: Arc::new(Semaphore::new(2)),
            changed: Arc::new(Notify::new()),
        }
    }
}
impl SearchState {
    fn begin(&self, owner: Owner, id: String) -> Arc<AtomicBool> {
        let mut requests = self.requests.lock().unwrap_or_else(|e| e.into_inner());
        let cancelled = Arc::new(AtomicBool::new(
            requests.cancelled.contains(&(owner.clone(), id.clone())),
        ));
        if let Some(old) = requests.current.insert(
            owner,
            Request {
                id,
                cancelled: cancelled.clone(),
            },
        ) {
            old.cancelled.store(true, Ordering::Release);
            self.changed.notify_waiters();
        }
        cancelled
    }
    fn finish(&self, owner: &Owner, flag: &Arc<AtomicBool>) {
        let mut requests = self.requests.lock().unwrap_or_else(|e| e.into_inner());
        if requests
            .current
            .get(owner)
            .is_some_and(|r| Arc::ptr_eq(&r.cancelled, flag))
        {
            requests.current.remove(owner);
        }
    }
    pub(crate) fn cancel(&self, owner: String, repository: String, id: String) {
        let owner = (owner, repository);
        let mut requests = self.requests.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(request) = requests.current.get(&owner).filter(|r| r.id == id) {
            request.cancelled.store(true, Ordering::Release);
        }
        if requests.cancelled.len() >= 256 {
            requests.cancelled.pop_front();
        }
        requests.cancelled.push_back((owner, id));
        self.changed.notify_waiters();
    }
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn search(
        &self,
        storage: Storage,
        repository: String,
        owner: String,
        query: String,
        request_id: String,
        buffers: Vec<EditorSearchBuffer>,
        paths: Option<Vec<String>>,
        publish: Publish,
    ) -> AppResult<EditorSearchResult> {
        if owner.is_empty() || owner.len() > 128 || request_id.is_empty() || request_id.len() > 128
        {
            return Err(AppError::new(
                "search_request",
                "Invalid search request identity.",
            ));
        }
        validate_query(&query)?;
        if buffers.len() > 256
            || buffers.iter().map(|b| b.text.len()).sum::<usize>() > TOTAL_BYTES as usize
        {
            return Err(AppError::new(
                "search_buffers",
                "Open buffers exceed the search memory limit.",
            ));
        }
        if paths.as_ref().is_some_and(|p| p.len() > 512) {
            return Err(AppError::new(
                "search_paths",
                "Too many changed search paths.",
            ));
        }
        let key = (owner, repository.clone());
        let cancelled = self.begin(key.clone(), request_id.clone());
        let permit = loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if cancelled.load(Ordering::Acquire) {
                self.finish(&key, &cancelled);
                return Ok(EditorSearchResult {
                    request_id,
                    cancelled: true,
                    ..Default::default()
                });
            }
            tokio::select! {
                permit = self.workers.clone().acquire_owned() => break permit.map_err(|_| AppError::new("search_closed", "Search is no longer available."))?,
                _ = changed => continue,
            }
        };
        let signal = cancelled.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            let _permit = permit;
            let root = crate::repositories::root(&storage, &repository)?;
            scan(
                &root,
                &query,
                request_id,
                &signal,
                Limits::default(),
                &buffers,
                paths.as_deref(),
                &mut |batch| publish(batch),
            )
        })
        .await
        .map_err(|e| AppError::new("search_task", e.to_string()))
        .and_then(|r| r);
        self.finish(&key, &cancelled);
        result.map(|mut result| {
            if cancelled.load(Ordering::Acquire) {
                result.cancelled = true;
                result.matches.clear();
            }
            result
        })
    }
}
fn validate_query(query: &str) -> AppResult<()> {
    if query.len() > MAX_QUERY_BYTES || query.contains(['\0', '\r', '\n']) {
        return Err(AppError::new(
            "search_query",
            "Search supports a single line of up to 512 UTF-8 bytes.",
        ));
    }
    Ok(())
}
#[derive(Clone, Copy)]
struct Limits {
    file_bytes: u64,
    total_bytes: u64,
    matches: usize,
    file_matches: usize,
    entries: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            file_bytes: FILE_BYTES,
            total_bytes: TOTAL_BYTES,
            matches: MATCHES,
            file_matches: FILE_MATCHES,
            entries: SCAN_ENTRIES,
        }
    }
}
struct Stream<'a> {
    request: String,
    sequence: u32,
    from: usize,
    last: Instant,
    publish: &'a mut dyn FnMut(EditorSearchBatch) -> bool,
}
impl Stream<'_> {
    fn flush(&mut self, result: &mut EditorSearchResult, force: bool) -> bool {
        let count = result.matches.len() - self.from;
        if count == 0 || (!force && count < 64 && self.last.elapsed() < Duration::from_millis(50)) {
            return true;
        }
        self.sequence += 1;
        let live = (self.publish)(EditorSearchBatch {
            request_id: self.request.clone(),
            sequence: self.sequence,
            matches: result.matches[self.from..].to_vec(),
        });
        self.from = result.matches.len();
        self.last = Instant::now();
        if !live {
            result.cancelled = true;
        }
        live
    }
}
#[allow(clippy::too_many_arguments)]
fn scan(
    root: &Path,
    query: &str,
    request_id: String,
    cancelled: &AtomicBool,
    limits: Limits,
    buffers: &[EditorSearchBuffer],
    only_paths: Option<&[String]>,
    publish: &mut dyn FnMut(EditorSearchBatch) -> bool,
) -> AppResult<EditorSearchResult> {
    validate_query(query)?;
    let mut result = EditorSearchResult {
        request_id: request_id.clone(),
        ..Default::default()
    };
    if query.is_empty() {
        return Ok(result);
    }
    if cancelled.load(Ordering::Acquire) {
        result.cancelled = true;
        return Ok(result);
    }
    let pattern = RegexMatcherBuilder::new()
        .case_insensitive(true)
        .build(&regex::escape(query))
        .map_err(|e| AppError::new("search_query", e.to_string()))?;
    let mut searcher = SearcherBuilder::new().line_number(true).build();
    let mut stream = Stream {
        request: request_id,
        sequence: 0,
        from: 0,
        last: Instant::now(),
        publish,
    };
    let mut overlays = BTreeMap::new();
    for buffer in buffers {
        super::path(root, &buffer.path)?;
        if overlays.insert(buffer.path.as_str(), buffer).is_some() {
            return Err(AppError::new(
                "search_buffers",
                "A buffer path occurs more than once.",
            ));
        }
    }
    let mut paths = BTreeSet::new();
    let mut exclusions = super::inventory::Exclusions::new(root);
    let selected = only_paths
        .map(|paths| {
            paths
                .iter()
                .map(|p| super::path(root, p))
                .collect::<AppResult<Vec<_>>>()
        })
        .transpose()?;
    // Walk from the checkout even for a subtree refresh: an explicitly passed ignored
    // directory must never bypass its parent's ignore rules.
    let mut walk = ignore::WalkBuilder::new(root);
    walk.hidden(false)
        .parents(false)
        .follow_links(false)
        .filter_entry(move |entry| {
            entry.depth() == 0
                || (!matches!(entry.file_name().to_str(), Some(".git" | ".reviewbox"))
                    && !entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with(".reviewbox-save-")
                    && selected.as_ref().is_none_or(|paths| {
                        paths.iter().any(|path| {
                            entry.path().starts_with(path) || path.starts_with(entry.path())
                        })
                    }))
        });
    let traversed = std::cell::Cell::new(0usize);
    let traversal_limit = std::cell::Cell::new(false);
    let candidates = walk
        .build()
        .take_while(|_| {
            if cancelled.load(Ordering::Acquire) {
                return false;
            }
            if traversed.get() >= limits.entries {
                traversal_limit.set(true);
                return false;
            }
            traversed.set(traversed.get() + 1);
            true
        })
        .filter_map(|entry| match entry {
            Ok(entry) if entry.file_type().is_some_and(|kind| kind.is_file()) => {
                Some(Ok(entry.into_path()))
            }
            Err(_) => Some(Err(())),
            _ => None,
        });
    let missing_buffers = overlays
        .keys()
        .filter(|p| {
            !root.join(p).is_file()
                && only_paths.is_none_or(|selected| {
                    selected
                        .iter()
                        .any(|s| *p == s || p.starts_with(&format!("{s}/")))
                })
        })
        .filter_map(|p| {
            let path = root.join(p);
            match exclusions.ignored(&path) {
                Ok(false) => Some(Ok(path)),
                _ => None,
            }
        })
        .collect::<Vec<_>>();
    let mut total_bytes = 0u64;
    let mut bytes = Vec::new();
    'files: for candidate in candidates.chain(missing_buffers) {
        if cancelled.load(Ordering::Acquire) || result.cancelled {
            result.cancelled = true;
            break;
        }
        let path = match candidate {
            Ok(path) => path,
            Err(_) => {
                result.skipped_files += 1;
                continue;
            }
        };
        let Some(relative) = path.strip_prefix(root).ok().and_then(Path::to_str) else {
            result.skipped_files += 1;
            continue;
        };
        let relative = relative.replace('\\', "/");
        if paths.len() >= limits.entries {
            result.truncated = true;
            break;
        }
        if !paths.insert(relative.clone()) {
            continue;
        }
        bytes.clear();
        if let Some(buffer) = overlays.get(relative.as_str()) {
            if buffer.text.len() as u64 > limits.file_bytes || buffer.text.contains('\0') {
                result.skipped_files += 1;
                continue;
            }
            bytes.extend_from_slice(buffer.text.as_bytes());
            total_bytes += bytes.len() as u64;
        } else {
            let file = super::path(root, &relative).and_then(|path| {
                let metadata = std::fs::symlink_metadata(&path)?;
                if !metadata.is_file() {
                    return Err(AppError::new(
                        "search_file",
                        "Search only reads regular files.",
                    ));
                }
                File::open(path).map_err(AppError::from)
            });
            let Ok(mut file) = file else {
                result.skipped_files += 1;
                continue;
            };
            let Ok(metadata) = file.metadata() else {
                result.skipped_files += 1;
                continue;
            };
            if !metadata.is_file() || metadata.len() > limits.file_bytes {
                result.skipped_files += 1;
                continue;
            }
            let mut chunk = [0; 64 * 1024];
            loop {
                if cancelled.load(Ordering::Acquire) {
                    result.cancelled = true;
                    break 'files;
                }
                match file.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(count) => {
                        total_bytes += count as u64;
                        if total_bytes > limits.total_bytes {
                            result.truncated = true;
                            break 'files;
                        }
                        if bytes.len() as u64 + count as u64 > limits.file_bytes
                            || chunk[..count].contains(&0)
                        {
                            result.skipped_files += 1;
                            continue 'files;
                        }
                        bytes.extend_from_slice(&chunk[..count]);
                    }
                    Err(_) => {
                        result.skipped_files += 1;
                        continue 'files;
                    }
                }
            }
        }
        if total_bytes > limits.total_bytes {
            result.truncated = true;
            break;
        }
        let Ok(text) = std::str::from_utf8(&bytes) else {
            result.skipped_files += 1;
            continue;
        };
        let text = text.strip_prefix('\u{feff}').unwrap_or(text);
        let text = if text.contains('\r') {
            Cow::Owned(text.replace("\r\n", "\n").replace('\r', "\n"))
        } else {
            Cow::Borrowed(text)
        };
        result.scanned_files += 1;
        let mut file_matches = 0;
        searcher
            .search_slice(
                &pattern,
                text.as_bytes(),
                UTF8(|line_number, raw_line| {
                    let line = raw_line.strip_suffix('\n').unwrap_or(raw_line);
                    pattern
                        .find_iter(line.as_bytes(), |found| {
                            if cancelled.load(Ordering::Acquire) {
                                result.cancelled = true;
                                return false;
                            }
                            if result.matches.len() >= limits.matches
                                || file_matches >= limits.file_matches
                            {
                                result.truncated = true;
                                return false;
                            }
                            let (preview, preview_column) =
                                preview(line, found.start(), found.end());
                            result.matches.push(EditorSearchMatch {
                                path: relative.clone(),
                                line: line_number as u32,
                                column: 1 + line[..found.start()].encode_utf16().count() as u32,
                                length: line[found.start()..found.end()].encode_utf16().count()
                                    as u32,
                                preview,
                                preview_column,
                            });
                            file_matches += 1;
                            if file_matches >= limits.file_matches {
                                result.truncated = true;
                            }
                            stream.flush(&mut result, false)
                        })
                        .map_err(std::io::Error::other)?;
                    Ok(!result.cancelled
                        && result.matches.len() < limits.matches
                        && file_matches < limits.file_matches)
                }),
            )
            .map_err(|e| AppError::new("search_scan", e.to_string()))?;
        if !stream.flush(&mut result, stream.sequence == 0) {
            break;
        }
        if result.matches.len() >= limits.matches {
            result.truncated = true;
            break;
        }
    }
    result.truncated |= traversal_limit.get();
    if cancelled.load(Ordering::Acquire) {
        result.cancelled = true;
    }
    if result.cancelled {
        result.matches.clear();
    } else {
        stream.flush(&mut result, true);
    }
    result
        .matches
        .sort_by(|a, b| (&a.path, a.line, a.column).cmp(&(&b.path, b.line, b.column)));
    Ok(result)
}

fn preview(line: &str, start: usize, end: usize) -> (String, u32) {
    let from = line[..start]
        .char_indices()
        .rev()
        .nth(60)
        .map_or(0, |(index, _)| index);
    let to = line[end..]
        .char_indices()
        .nth(160)
        .map_or(line.len(), |(index, _)| end + index);
    let prefix = if from > 0 { "…" } else { "" };
    let suffix = if to < line.len() { "…" } else { "" };
    (
        format!("{prefix}{}{suffix}", &line[from..to]),
        1 + prefix.encode_utf16().count() as u32 + line[from..start].encode_utf16().count() as u32,
    )
}

#[cfg(test)]
mod tests;
