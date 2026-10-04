//! Bounded stderr capture. Stdout remains the provider protocol, never a log.
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};
use tokio::io::AsyncReadExt;

const MAX_LINE: usize = 8192;
const MAX_TAIL: usize = 16_384;

#[derive(Default)]
struct Tail {
    lines: VecDeque<String>,
    bytes: usize,
    partial: Vec<u8>,
    dropping: bool,
    private_key: bool,
}
impl Tail {
    fn feed(&mut self, chunk: &[u8]) {
        for byte in chunk {
            if *byte == b'\n' {
                self.line();
            } else if !self.dropping {
                if self.partial.len() == MAX_LINE {
                    let prefix = String::from_utf8_lossy(&self.partial);
                    self.private_key |=
                        prefix.contains("-----BEGIN ") && prefix.contains("PRIVATE KEY-----");
                    self.partial.clear();
                    self.dropping = true;
                } else {
                    self.partial.push(*byte);
                }
            }
        }
    }
    fn line(&mut self) {
        let raw = String::from_utf8_lossy(&self.partial);
        let secret =
            self.private_key || (raw.contains("-----BEGIN ") && raw.contains("PRIVATE KEY-----"));
        self.private_key =
            secret && !(raw.contains("-----END ") && raw.contains("PRIVATE KEY-----"));
        let line = if secret {
            "[private key omitted]".into()
        } else if self.dropping {
            "[oversized stderr line omitted]".into()
        } else {
            crate::diagnostics::redact(&raw, MAX_LINE)
        };
        self.partial.clear();
        self.dropping = false;
        self.bytes += line.len() + 1;
        self.lines.push_back(line);
        while self.bytes > MAX_TAIL {
            if let Some(line) = self.lines.pop_front() {
                self.bytes -= line.len() + 1;
            }
        }
    }
}

pub(super) struct Stderr {
    tail: Arc<Mutex<Tail>>,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
}
impl Stderr {
    pub(super) fn capture(mut input: tokio::process::ChildStderr) -> Self {
        let tail = Arc::new(Mutex::new(Tail::default()));
        let writing = tail.clone();
        let task = tauri::async_runtime::spawn(async move {
            let mut buffer = [0; 2048];
            while let Ok(size) = input.read(&mut buffer).await {
                if size == 0 {
                    break;
                }
                if let Ok(mut tail) = writing.lock() {
                    tail.feed(&buffer[..size]);
                }
            }
            if let Ok(mut tail) = writing.lock()
                && (!tail.partial.is_empty() || tail.dropping)
            {
                tail.line();
            }
        });
        Self {
            tail,
            task: Some(task),
        }
    }
    pub(super) async fn text(&mut self) -> String {
        if let Some(task) = self.task.as_mut()
            && tokio::time::timeout(std::time::Duration::from_millis(100), task)
                .await
                .is_ok()
        {
            self.task = None;
        }
        let text = self
            .tail
            .lock()
            .map(|t| t.lines.iter().cloned().collect::<Vec<_>>().join("\n"))
            .unwrap_or_default();
        crate::diagnostics::redact(&text, MAX_TAIL)
    }
}
impl Drop for Stderr {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tail_is_bounded_and_never_slices_credentials_or_large_lines() {
        let mut tail = Tail::default();
        tail.feed(b"Authorization: Bearer ");
        tail.feed(b"private-token\nreal failure: 401\n");
        assert!(!tail.lines.iter().any(|l| l.contains("private-token")));
        assert!(tail.lines.iter().any(|l| l.contains("401")));
        tail.feed(&vec![b'x'; MAX_LINE + 20]);
        tail.feed(b"\n");
        assert_eq!(
            tail.lines.back().unwrap(),
            "[oversized stderr line omitted]"
        );
        for _ in 0..2000 {
            tail.feed(b"a complete error line\n");
        }
        assert!(tail.bytes <= MAX_TAIL);
        assert!(tail.lines.iter().all(|l| l == "a complete error line"));
    }
    #[test]
    fn private_keys_remain_hidden_across_lines_and_tail_eviction() {
        let mut tail = Tail::default();
        tail.feed(b"-----BEGIN PRIVATE KEY-----\n");
        for _ in 0..2000 {
            tail.feed(b"sensitive-base64\n");
        }
        tail.feed(b"-----END PRIVATE KEY-----\nactual failure\n");
        assert!(!tail.lines.iter().any(|l| l.contains("sensitive-base64")));
        assert_eq!(tail.lines.back().unwrap(), "actual failure");
    }
}
