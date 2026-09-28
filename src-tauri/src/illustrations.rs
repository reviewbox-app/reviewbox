//! Ephemeral, origin-isolated reader illustrations. No disk or generic IPC bridge.
use crate::contracts::{AppError, AppResult, id};
use std::{collections::HashMap, sync::Mutex};
use tauri::{Manager, State};

#[derive(Default)]
pub(crate) struct Illustrations(Mutex<HashMap<String, (String, String)>>);
const CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts";

#[tauri::command]
pub(crate) fn register_illustration(
    window: tauri::WebviewWindow,
    state: State<'_, Illustrations>,
    html: String,
) -> AppResult<String> {
    let mut entries = state
        .0
        .lock()
        .map_err(|_| AppError::new("illustration", "Illustration state is unavailable."))?;
    // Runtime transport/memory protection, independent of authored document length.
    if html.len() > 2 * 1024 * 1024
        || entries.len() >= 128
        || entries.values().map(|(_, html)| html.len()).sum::<usize>() + html.len()
            > 32 * 1024 * 1024
    {
        return Err(AppError::new(
            "illustration",
            "Too many illustrations are open.",
        ));
    }
    let key = id();
    entries.insert(key.clone(), (window.label().into(), html));
    Ok(key)
}
#[tauri::command]
pub(crate) fn release_illustration(
    window: tauri::WebviewWindow,
    state: State<'_, Illustrations>,
    id: String,
) -> AppResult<()> {
    let mut entries = state
        .0
        .lock()
        .map_err(|_| AppError::new("illustration", "Illustration state is unavailable."))?;
    if entries
        .get(&id)
        .is_some_and(|(owner, _)| owner == window.label())
    {
        entries.remove(&id);
    }
    Ok(())
}
impl Illustrations {
    pub(crate) fn release_window(&self, owner: &str) {
        if let Ok(mut entries) = self.0.lock() {
            entries.retain(|_, (window, _)| window != owner);
        }
    }
}
pub(crate) fn protocol(
    context: tauri::UriSchemeContext<'_, tauri::Wry>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let key = request.uri().path().trim_start_matches('/');
    let state = context.app_handle().state::<Illustrations>();
    let body = state.0.lock().ok().and_then(|entries| {
        entries
            .get(key)
            .filter(|(owner, _)| owner == context.webview_label())
            .map(|(_, html)| html.clone())
    });
    tauri::http::Response::builder()
        .status(if body.is_some() { 200 } else { 404 })
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Content-Security-Policy", CSP)
        .header("Cache-Control", "no-store")
        .header("Referrer-Policy", "no-referrer")
        .header("X-Content-Type-Options", "nosniff")
        .header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=(), clipboard-write=()")
        .body(body.unwrap_or_default().into_bytes()).expect("static response headers")
}
pub(crate) fn navigation_allowed(url: &tauri::Url) -> bool {
    match (url.scheme(), url.host_str()) {
        ("reviewbox-illustration", Some("localhost"))
        | ("http" | "https", Some("reviewbox-illustration.localhost")) => {
            url.query().is_none()
                && url
                    .path()
                    .trim_start_matches('/')
                    .parse::<uuid::Uuid>()
                    .is_ok()
        }
        ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost")) => true,
        ("http", Some("127.0.0.1")) if cfg!(debug_assertions) => url.port() == Some(1420),
        ("about", _) => url.as_str() == "about:blank",
        _ => false,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn blocks_network_file_and_ipc_navigation() {
        for url in [
            "https://example.com/leak",
            "file:///etc/passwd",
            "ipc://localhost",
            "data:text/html,hello",
            "reviewbox-illustration://localhost/not-an-id",
        ] {
            assert!(!navigation_allowed(&url.parse().unwrap()), "{url}");
        }
        assert!(navigation_allowed(
            &format!("reviewbox-illustration://localhost/{}", id())
                .parse()
                .unwrap()
        ));
        assert!(!CSP.contains("allow-same-origin"));
        assert!(CSP.contains("connect-src 'none'"));
    }
}
