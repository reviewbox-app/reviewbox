//! User-owned interactive shells. Output lives only in the terminal stream.
mod commands;
mod process;
pub use commands::*;

use crate::contracts::{AppError, AppResult, TerminalEvent, TerminalSession};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::{
    collections::{BTreeMap, VecDeque},
    io::{Read, Write},
    path::Path,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

const MAX_SESSIONS: usize = 32;
const MAX_IN_FLIGHT: usize = 256 * 1024;
type Sink = Arc<dyn Fn(TerminalEvent) -> bool + Send + Sync>;

#[derive(Default)]
struct Flow {
    sequence: u32,
    outstanding: VecDeque<(u32, usize)>,
    bytes: usize,
}
impl Flow {
    fn acknowledge(&mut self, sequence: u32) {
        // Ignore fabricated future ACKs; each sequence accounts for exactly its original bytes.
        if sequence > self.sequence {
            return;
        }
        while self
            .outstanding
            .front()
            .is_some_and(|(seq, _)| *seq <= sequence)
        {
            self.bytes -= self.outstanding.pop_front().unwrap().1;
        }
    }
}
struct Session {
    info: Mutex<TerminalSession>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    pid: Option<u32>,
    stopped: AtomicBool,
    flow: Mutex<Flow>,
    ready: Condvar,
}
impl Session {
    fn stop(&self) {
        // The stop predicate and wait must use the same mutex. Notifying an
        // atomic flag without this lock can lose a wake just before Condvar::wait.
        let flow = self.flow.lock().unwrap_or_else(|e| e.into_inner());
        if self.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        self.ready.notify_all();
        drop(flow);
        let foreground = self
            .master
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .and_then(|m| {
                #[cfg(unix)]
                {
                    m.process_group_leader().map(|pid| pid as u32)
                }
                #[cfg(not(unix))]
                {
                    let _ = m;
                    None
                }
            });
        if !self.info.lock().unwrap_or_else(|e| e.into_inner()).exited {
            process::terminate(self.pid, foreground);
            let _ = self.killer.lock().unwrap_or_else(|e| e.into_inner()).kill();
        }
        self.writer.lock().unwrap_or_else(|e| e.into_inner()).take();
        self.master.lock().unwrap_or_else(|e| e.into_inner()).take();
    }
}
#[derive(Default)]
pub struct Terminals {
    sessions: Mutex<BTreeMap<String, Arc<Session>>>,
    stopping: AtomicBool,
}
impl Terminals {
    pub fn active_count(&self) -> usize {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter(|s| !s.info.lock().unwrap_or_else(|e| e.into_inner()).exited)
            .count()
    }
    pub fn stop_all(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        let sessions =
            std::mem::take(&mut *self.sessions.lock().unwrap_or_else(|e| e.into_inner()));
        for session in sessions.into_values() {
            session.stop();
        }
    }
    fn session(&self, id: &str) -> AppResult<Arc<Session>> {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::new("terminal_missing", "This terminal has closed."))
    }
    fn start(
        &self,
        repository_id: String,
        root: &Path,
        cols: u16,
        rows: u16,
        sink: Sink,
    ) -> AppResult<TerminalSession> {
        self.start_command(
            repository_id,
            root,
            cols,
            rows,
            sink,
            CommandBuilder::new_default_prog(),
        )
    }
    fn start_command(
        &self,
        repository_id: String,
        root: &Path,
        cols: u16,
        rows: u16,
        sink: Sink,
        mut command: CommandBuilder,
    ) -> AppResult<TerminalSession> {
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        if self.stopping.load(Ordering::SeqCst) {
            return Err(AppError::new("terminal_shutdown", "ReviewBox is closing."));
        }
        if sessions.len() >= MAX_SESSIONS {
            return Err(AppError::new(
                "terminal_limit",
                "Close a terminal before opening another (32 maximum).",
            ));
        }
        validate_size(cols, rows)?;
        let pair = native_pty_system()
            .openpty(PtySize {
                cols,
                rows,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(native_error)?;
        command.cwd(root);
        command.env("TERM", "xterm-256color");
        command.env("TERM_PROGRAM", "ReviewBox");
        command.env("COLORTERM", "truecolor");
        // portable-pty selects the user's configured login shell on Unix.
        let mut reader = pair.master.try_clone_reader().map_err(native_error)?;
        let writer = pair.master.take_writer().map_err(native_error)?;
        let mut child = pair.slave.spawn_command(command).map_err(native_error)?;
        let pid = child.process_id();
        let killer = child.clone_killer();
        drop(pair.slave);
        let info = TerminalSession {
            id: uuid::Uuid::new_v4().to_string(),
            repository_id,
            shell: default_shell(),
            cwd: root.to_string_lossy().into_owned(),
            exited: false,
            exit_code: None,
        };
        let session = Arc::new(Session {
            info: Mutex::new(info.clone()),
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(Some(writer)),
            killer: Mutex::new(killer),
            pid,
            stopped: AtomicBool::new(false),
            flow: Mutex::new(Flow::default()),
            ready: Condvar::new(),
        });
        sessions.insert(info.id.clone(), session.clone());
        drop(sessions);
        let output_session = session.clone();
        let output_sink = sink.clone();
        let id = info.id.clone();
        std::thread::spawn(move || {
            let mut buffer = [0u8; 16 * 1024];
            loop {
                let mut flow = output_session
                    .flow
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                while flow.bytes >= MAX_IN_FLIGHT && !output_session.stopped.load(Ordering::SeqCst)
                {
                    flow = output_session
                        .ready
                        .wait(flow)
                        .unwrap_or_else(|e| e.into_inner());
                }
                if output_session.stopped.load(Ordering::SeqCst) {
                    break;
                }
                drop(flow);
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(length) => {
                        let sequence = {
                            let mut flow = output_session
                                .flow
                                .lock()
                                .unwrap_or_else(|e| e.into_inner());
                            flow.sequence = flow.sequence.saturating_add(1);
                            let sequence = flow.sequence;
                            flow.outstanding.push_back((sequence, length));
                            flow.bytes += length;
                            sequence
                        };
                        if !output_sink(TerminalEvent::Data {
                            id: id.clone(),
                            sequence,
                            bytes: buffer[..length].to_vec(),
                        }) {
                            output_session.stop();
                            break;
                        }
                    }
                    Err(error) => {
                        if !output_session.stopped.load(Ordering::SeqCst) {
                            output_sink(TerminalEvent::Error {
                                id: id.clone(),
                                message: format!("Terminal output failed: {error}"),
                            });
                        }
                        output_session.stop();
                        break;
                    }
                }
            }
            // Wait after draining the PTY, so the final output always precedes Exit.
            // On cancellation the reader's duplicate is the last master handle;
            // close it before wait, otherwise a backpressured Unix PTY can keep
            // the dying child in terminal drain while nobody reads its output.
            drop(reader);
            let status = child.wait();
            let code = status.ok().map(|value| value.exit_code());
            {
                let mut info = output_session
                    .info
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                info.exited = true;
                info.exit_code = code;
            }
            output_session.stop();
            sink(TerminalEvent::Exit { id, code });
        });
        Ok(info)
    }
}
impl Drop for Terminals {
    fn drop(&mut self) {
        self.stop_all();
    }
}
fn validate_size(cols: u16, rows: u16) -> AppResult<()> {
    if cols == 0 || rows == 0 || cols > 1000 || rows > 500 {
        return Err(AppError::new(
            "terminal_size",
            "Invalid terminal dimensions.",
        ));
    }
    Ok(())
}
fn native_error(error: impl std::fmt::Display) -> AppError {
    AppError::new("terminal_io", error.to_string())
}
fn default_shell() -> String {
    #[cfg(unix)]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
    }
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into())
    }
}

#[cfg(test)]
mod tests;
