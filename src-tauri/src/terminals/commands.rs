use super::*;
use crate::{contracts::TerminalLink, storage::Storage};
use tauri::{Manager, State};

fn main_window(window: &tauri::WebviewWindow) -> AppResult<()> {
    if window.label() != "main" {
        return Err(AppError::new(
            "terminal_window",
            "Terminals belong to the main window.",
        ));
    }
    Ok(())
}
#[tauri::command]
pub async fn terminal_create(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    repository_id: String,
    cols: u16,
    rows: u16,
    on_event: tauri::ipc::Channel<TerminalEvent>,
) -> AppResult<TerminalSession> {
    main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let storage = app.state::<Storage>();
        let root = crate::repositories::root(&storage, &repository_id)?;
        app.state::<Terminals>().start(
            repository_id,
            &root,
            cols,
            rows,
            Arc::new(move |event| on_event.send(event).is_ok()),
        )
    })
    .await
    .map_err(native_error)?
}
#[tauri::command]
pub fn terminal_list(
    window: tauri::WebviewWindow,
    state: State<'_, Terminals>,
) -> AppResult<Vec<TerminalSession>> {
    main_window(&window)?;
    Ok(state
        .sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .map(|session| {
            session
                .info
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone()
        })
        .collect())
}
#[tauri::command]
pub async fn terminal_write(
    window: tauri::WebviewWindow,
    state: State<'_, Terminals>,
    id: String,
    bytes: Vec<u8>,
) -> AppResult<()> {
    main_window(&window)?;
    if bytes.len() > 64 * 1024 {
        return Err(AppError::new(
            "terminal_input",
            "Terminal input exceeds the chunk limit.",
        ));
    }
    let session = state.session(&id)?;
    tauri::async_runtime::spawn_blocking(move || {
        if session.stopped.load(Ordering::SeqCst) {
            return Err(AppError::new(
                "terminal_closed",
                "This terminal has exited.",
            ));
        }
        let mut writer = session
            .writer
            .try_lock()
            .map_err(|_| AppError::new("terminal_busy", "Terminal input is busy."))?;
        writer
            .as_mut()
            .ok_or_else(|| AppError::new("terminal_closed", "This terminal has closed."))?
            .write_all(&bytes)
            .map_err(native_error)
    })
    .await
    .map_err(native_error)?
}
#[tauri::command]
pub async fn terminal_resize(
    window: tauri::WebviewWindow,
    state: State<'_, Terminals>,
    id: String,
    cols: u16,
    rows: u16,
) -> AppResult<()> {
    main_window(&window)?;
    validate_size(cols, rows)?;
    let Ok(session) = state.session(&id) else {
        return Ok(());
    };
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(master) = session
            .master
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            master
                .resize(PtySize {
                    cols,
                    rows,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(native_error)?;
        }
        Ok(())
    })
    .await
    .map_err(native_error)?
}
#[tauri::command]
pub fn terminal_ack(
    window: tauri::WebviewWindow,
    state: State<'_, Terminals>,
    id: String,
    sequence: u32,
) -> AppResult<()> {
    main_window(&window)?;
    // Output can already be queued in WebKit when a tab is closed.
    let Ok(session) = state.session(&id) else {
        return Ok(());
    };
    session
        .flow
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .acknowledge(sequence);
    session.ready.notify_all();
    Ok(())
}
#[tauri::command]
pub async fn terminal_close(
    window: tauri::WebviewWindow,
    state: State<'_, Terminals>,
    id: String,
) -> AppResult<()> {
    main_window(&window)?;
    let session = state
        .sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&id);
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(session) = session {
            session.stop();
        }
    })
    .await
    .map_err(native_error)?;
    Ok(())
}
#[tauri::command]
pub async fn terminal_open_url(window: tauri::WebviewWindow, url: String) -> AppResult<()> {
    main_window(&window)?;
    let parsed = url::Url::parse(&url).map_err(native_error)?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(AppError::new(
            "terminal_link",
            "Only HTTP and HTTPS links can open externally.",
        ));
    }
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        let mut command = std::process::Command::new("open");
        #[cfg(target_os = "linux")]
        let mut command = std::process::Command::new("xdg-open");
        #[cfg(target_os = "windows")]
        let mut command = {
            let mut c = std::process::Command::new("rundll32");
            c.arg("url.dll,FileProtocolHandler");
            c
        };
        command
            .arg(parsed.as_str())
            .status()
            .map_err(native_error)
            .and_then(|status| {
                if status.success() {
                    Ok(())
                } else {
                    Err(AppError::new(
                        "terminal_link",
                        "The browser could not open this link.",
                    ))
                }
            })
    })
    .await
    .map_err(native_error)?
}
#[tauri::command]
pub async fn terminal_resolve_file(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    id: String,
    path: String,
    line: u32,
    column: u32,
) -> AppResult<TerminalLink> {
    main_window(&window)?;
    let session = app.state::<Terminals>().session(&id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let info = session
            .info
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let root = crate::repositories::root(&app.state::<Storage>(), &info.repository_id)?
            .canonicalize()
            .map_err(native_error)?;
        let cwd = process::cwd(session.pid).unwrap_or_else(|| root.clone());
        let target = cwd.join(path).canonicalize().map_err(native_error)?;
        if !target.is_file() {
            return Err(AppError::new(
                "terminal_link",
                "This link does not point to a file.",
            ));
        }
        let relative = target.strip_prefix(root).map_err(|_| {
            AppError::new(
                "terminal_link",
                "This file is outside the current checkout.",
            )
        })?;
        Ok(TerminalLink {
            path: relative.to_string_lossy().replace('\\', "/"),
            line: line.max(1),
            column: column.max(1),
        })
    })
    .await
    .map_err(native_error)?
}
