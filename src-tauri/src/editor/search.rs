//! Bounded, read-only content search. Only the latest request may scan a checkout.
use crate::{contracts::*, storage::Storage};
use regex::RegexBuilder;
use std::{
    borrow::Cow,
    fs::File,
    io::Read,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;

const MAX_QUERY_BYTES: usize = 512;
const FILE_BYTES: u64 = 2 * 1024 * 1024;
const TOTAL_BYTES: u64 = 256 * 1024 * 1024;
const MATCHES: usize = 1_000;
const FILE_MATCHES: usize = 100;
const SCAN_TIME: Duration = Duration::from_secs(3);

struct Request {
    id: String,
    cancelled: Arc<AtomicBool>,
}

#[derive(Clone)]
pub(crate) struct SearchState {
    current: Arc<Mutex<Option<Request>>>,
    worker: Arc<Semaphore>,
}

impl Default for SearchState {
    fn default() -> Self {
        Self {
            current: Arc::default(),
            worker: Arc::new(Semaphore::new(1)),
        }
    }
}

impl SearchState {
    fn begin(&self, id: String) -> Arc<AtomicBool> {
        let cancelled = Arc::new(AtomicBool::new(false));
        let previous = self
            .current
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .replace(Request {
                id,
                cancelled: cancelled.clone(),
            });
        if let Some(previous) = previous {
            previous.cancelled.store(true, Ordering::Relaxed);
        }
        cancelled
    }

    fn finish(&self, cancelled: &Arc<AtomicBool>) {
        let mut current = self.current.lock().unwrap_or_else(|e| e.into_inner());
        if current
            .as_ref()
            .is_some_and(|request| Arc::ptr_eq(&request.cancelled, cancelled))
        {
            *current = None;
        }
    }

    pub(crate) fn cancel(&self, id: &str) {
        let current = self.current.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(request) = current.as_ref().filter(|request| request.id == id) {
            request.cancelled.store(true, Ordering::Relaxed);
        }
    }

    pub(crate) async fn search(
        &self,
        storage: Storage,
        repository: String,
        query: String,
        request_id: String,
    ) -> AppResult<EditorSearchResult> {
        if request_id.is_empty() || request_id.len() > 128 {
            return Err(AppError::new(
                "search_request",
                "Invalid search request identity.",
            ));
        }
        validate_query(&query)?;
        let cancelled = self.begin(request_id.clone());
        // Cancelling spawn_blocking cannot stop running I/O. The token is checked
        // during traversal, reads and matching; a single permit bounds CPU and I/O.
        let permit = self.worker.clone().acquire_owned().await.map_err(|_| {
            AppError::new("search_closed", "Content search is no longer available.")
        })?;
        let signal = cancelled.clone();
        let result = if signal.load(Ordering::Relaxed) || query.is_empty() {
            Ok(EditorSearchResult {
                request_id,
                cancelled: signal.load(Ordering::Relaxed),
                ..Default::default()
            })
        } else {
            tauri::async_runtime::spawn_blocking(move || {
                let _permit = permit;
                if signal.load(Ordering::Relaxed) {
                    return Ok(EditorSearchResult {
                        request_id,
                        cancelled: true,
                        ..Default::default()
                    });
                }
                let root = crate::repositories::root(&storage, &repository)?;
                scan(&root, &query, request_id, &signal, Limits::default())
            })
            .await
            .map_err(|e| AppError::new("search_task", e.to_string()))
            .and_then(|result| result)
        };
        self.finish(&cancelled);
        result.map(|mut result| {
            // Cancellation can arrive between the final scan check and completion.
            if cancelled.load(Ordering::Relaxed) {
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
    time: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            file_bytes: FILE_BYTES,
            total_bytes: TOTAL_BYTES,
            matches: MATCHES,
            file_matches: FILE_MATCHES,
            time: SCAN_TIME,
        }
    }
}

fn scan(
    root: &Path,
    query: &str,
    request_id: String,
    cancelled: &AtomicBool,
    limits: Limits,
) -> AppResult<EditorSearchResult> {
    validate_query(query)?;
    let mut result = EditorSearchResult {
        request_id,
        ..Default::default()
    };
    if query.is_empty() {
        return Ok(result);
    }
    let pattern = RegexBuilder::new(&regex::escape(query))
        .case_insensitive(true)
        .build()
        .map_err(|e| AppError::new("search_query", e.to_string()))?;
    let start = Instant::now();
    let mut total_bytes = 0;
    let mut bytes = Vec::new();
    let mut walk = ignore::WalkBuilder::new(root);
    walk.hidden(false)
        .follow_links(false)
        .filter_entry(|entry| {
            entry.depth() == 0 || !matches!(entry.file_name().to_str(), Some(".git" | ".reviewbox"))
        });
    'files: for entry in walk.build() {
        if interrupted(&mut result, cancelled, start, limits.time) {
            break;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                result.skipped_files += 1;
                continue;
            }
        };
        if !entry.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        let Some(relative) = entry.path().strip_prefix(root).ok().and_then(Path::to_str) else {
            result.skipped_files += 1;
            continue;
        };
        let relative = relative.replace('\\', "/");
        let file =
            super::path(root, &relative).and_then(|path| File::open(path).map_err(AppError::from));
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
        bytes.clear();
        let mut chunk = [0; 64 * 1024];
        loop {
            if interrupted(&mut result, cancelled, start, limits.time) {
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
        let Ok(text) = std::str::from_utf8(&bytes) else {
            result.skipped_files += 1;
            continue;
        };
        let text = text.strip_prefix('\u{feff}').unwrap_or(text);
        // Match the editor's line coordinates, including legacy CR-only files.
        let text = if text.contains('\r') {
            Cow::Owned(text.replace("\r\n", "\n").replace('\r', "\n"))
        } else {
            Cow::Borrowed(text)
        };
        result.scanned_files += 1;
        let mut file_matches = 0;
        for (line_index, line) in text.lines().enumerate() {
            if interrupted(&mut result, cancelled, start, limits.time) {
                break 'files;
            }
            let mut previous_end = 0;
            let mut column = 1;
            for found in pattern.find_iter(line) {
                if interrupted(&mut result, cancelled, start, limits.time) {
                    break 'files;
                }
                if result.matches.len() >= limits.matches {
                    result.truncated = true;
                    break 'files;
                }
                if file_matches >= limits.file_matches {
                    result.truncated = true;
                    continue 'files;
                }
                column += line[previous_end..found.start()].encode_utf16().count() as u32;
                let length = found.as_str().encode_utf16().count() as u32;
                let (preview, preview_column) = preview(line, found.start(), found.end());
                result.matches.push(EditorSearchMatch {
                    path: relative.clone(),
                    line: line_index as u32 + 1,
                    column,
                    length,
                    preview,
                    preview_column,
                });
                column += length;
                previous_end = found.end();
                file_matches += 1;
            }
        }
    }
    if result.cancelled {
        result.matches.clear();
    }
    result
        .matches
        .sort_by(|a, b| (&a.path, a.line, a.column).cmp(&(&b.path, b.line, b.column)));
    Ok(result)
}

fn interrupted(
    result: &mut EditorSearchResult,
    cancelled: &AtomicBool,
    start: Instant,
    time: Duration,
) -> bool {
    if cancelled.load(Ordering::Relaxed) {
        result.cancelled = true;
        true
    } else if start.elapsed() >= time {
        result.truncated = true;
        true
    } else {
        false
    }
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
