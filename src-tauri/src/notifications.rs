//! Desktop completion alerts. The OS owns presentation, sound and notification history.
#[cfg(target_os = "macos")]
mod macos;
#[cfg(test)]
mod tests;

use crate::contracts::*;
#[cfg(target_os = "macos")]
use crate::storage::Storage;
use std::sync::Mutex;
#[cfg(target_os = "macos")]
use tauri::{Emitter, Manager};

#[cfg(target_os = "macos")]
const OPEN_EVENT: &str = "reviewbox:open-review-notification";
#[cfg(any(target_os = "macos", test))]
const IDENTIFIER_PREFIX: &str = "reviewbox:review-ready:";

#[derive(Default)]
pub(crate) struct Notifications {
    // Keep the destination until the main webview has handled it. This also
    // covers a click that launches the app before React subscribes.
    pending: Mutex<Option<ReviewNotificationTarget>>,
    #[cfg(target_os = "macos")]
    delegate: Mutex<Option<macos::DelegateOwner>>,
}

impl Notifications {
    fn acknowledge(&self, operation_id: &str) {
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if pending
            .as_ref()
            .is_some_and(|target| target.operation_id == operation_id)
        {
            *pending = None;
        }
    }
}

pub(crate) fn install(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    if native_enabled(app) {
        *app.state::<Notifications>()
            .delegate
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(macos::install(app.clone()));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

pub(crate) fn shutdown(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    if app
        .state::<Notifications>()
        .delegate
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
        .is_some()
    {
        macos::uninstall();
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Ask in the context of starting Rev, never during app startup or tests.
pub(crate) fn prepare(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    if native_enabled(app) {
        macos::request_permission();
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

pub(crate) fn review_ready(app: &tauri::AppHandle, target: ReviewNotificationTarget) {
    #[cfg(target_os = "macos")]
    if native_enabled(app) {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let storage = app.state::<Storage>().scoped(Some(&target.repository_id));
            // A removed review must not leave an alert pointing at another review.
            let Ok(review) = storage.get::<Review>("review", &target.review_id) else {
                return;
            };
            let Ok(repository) = storage.get::<Repository>("repository", &target.repository_id)
            else {
                return;
            };
            macos::show(&target, &repository.name, &review.title);
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, target);
}

#[cfg(target_os = "macos")]
fn native_enabled(app: &tauri::AppHandle) -> bool {
    !cfg!(any(test, feature = "native-validation")) && macos::is_bundled(&app.config().identifier)
}

#[cfg(any(target_os = "macos", test))]
fn identifier(target: &ReviewNotificationTarget) -> String {
    // The OS retains these local IDs with the alert, including across app restarts.
    format!(
        "{IDENTIFIER_PREFIX}{}",
        serde_json::to_string(target).expect("string-only notification target")
    )
}

#[cfg(any(target_os = "macos", test))]
fn parse_identifier(value: &str) -> Option<ReviewNotificationTarget> {
    if value.len() > 1024 {
        return None;
    }
    let target: ReviewNotificationTarget =
        serde_json::from_str(value.strip_prefix(IDENTIFIER_PREFIX)?).ok()?;
    let valid = uuid::Uuid::parse_str(&target.operation_id).is_ok()
        && uuid::Uuid::parse_str(&target.review_id).is_ok()
        && target.repository_id.len() == 64
        && target
            .repository_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit());
    valid.then_some(target)
}

#[cfg(target_os = "macos")]
fn activate(app: &tauri::AppHandle, target: ReviewNotificationTarget) {
    *app.state::<Notifications>()
        .pending
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(target.clone());
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        let _ = window.emit(OPEN_EVENT, target);
    }
}

#[tauri::command]
pub(crate) fn pending_review_notification(
    state: tauri::State<'_, Notifications>,
) -> Option<ReviewNotificationTarget> {
    state
        .pending
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

#[tauri::command]
pub(crate) fn acknowledge_review_notification(
    state: tauri::State<'_, Notifications>,
    operation_id: String,
) {
    state.acknowledge(&operation_id);
}
