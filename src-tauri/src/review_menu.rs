use parking_lot::Mutex;
#[cfg(target_os = "macos")]
mod macos;
use tauri::{
    AppHandle, Emitter, Manager,
    menu::{
        CheckMenuItem, IconMenuItem, Menu, MenuItem, NativeIcon, PredefinedMenuItem, Submenu,
        WINDOW_SUBMENU_ID,
    },
};

use crate::contracts::{
    AppError, AppResult, PublicationStatus, ReviewMenuAction, ReviewMenuEvent, ReviewMenuState,
};

/// A single native menu follows the reader in the main window, including on macOS
/// where every window shares the application menu bar.
pub(crate) struct ReviewMenu {
    submenu: Submenu<tauri::Wry>,
    context: Mutex<Option<ReviewMenuState>>,
}

pub(crate) fn install(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::default(app)?;
    let submenu = Submenu::with_id(app, "review", "Review", false)?;
    submenu.append(&MenuItem::new(app, "No review open", false, None::<&str>)?)?;
    let position = menu
        .items()?
        .iter()
        .position(|item| item.id().as_ref() == WINDOW_SUBMENU_ID)
        .unwrap_or(menu.items()?.len().saturating_sub(2));
    menu.insert(&submenu, position)?;
    #[cfg(debug_assertions)]
    install_inspector(app, &menu)?;
    app.set_menu(menu)?;
    app.manage(ReviewMenu {
        submenu,
        context: Mutex::new(None),
    });
    app.on_menu_event(|app, event| {
        let Some(action) = action_from_id(event.id().as_ref()) else {
            return;
        };
        let menu = app.state::<ReviewMenu>();
        let context = menu.context.lock().clone();
        let Some(context) = context else { return };
        // Checkbox clicks toggle natively. Restore the durable value until the
        // human action succeeds, so a stale click cannot leave a false check.
        if action == ReviewMenuAction::KeepLocal
            && let Some(item) = menu.submenu.get(action_id(action))
            && let Some(item) = item.as_check_menuitem()
        {
            let _ = item.set_checked(context.keep_local);
        }
        if !context
            .entries
            .iter()
            .any(|entry| entry.action == action && entry.enabled)
            // Opening the OS menu temporarily takes focus from the WebView.
            // The submenu tracks the active application window separately.
            || !menu.submenu.is_enabled().unwrap_or(false)
        {
            return;
        }
        let _ = app.emit_to(
            "main",
            "reviewbox:review-menu",
            ReviewMenuEvent {
                review_id: context.review_id,
                snapshot_id: context.snapshot_id,
                action,
            },
        );
    });
    Ok(())
}

/// Register a native accelerator: WKWebView does not consistently provide its
/// documented inspector shortcut, and editor key handlers can consume it.
#[cfg(debug_assertions)]
fn install_inspector(app: &AppHandle, menu: &Menu<tauri::Wry>) -> tauri::Result<()> {
    let shortcut = if cfg!(target_os = "macos") {
        "Cmd+Alt+I"
    } else {
        "Ctrl+Shift+I"
    };
    let item = MenuItem::with_id(
        app,
        "debug.inspector",
        "Toggle Web Inspector",
        true,
        Some(shortcut),
    )?;
    let view = menu.items()?.into_iter().find_map(|item| {
        let submenu = item.as_submenu()?;
        (submenu.text().ok()?.as_str() == "View").then(|| submenu.clone())
    });
    if let Some(view) = view {
        view.append(&PredefinedMenuItem::separator(app)?)?;
        view.append(&item)?;
    } else {
        menu.append(&Submenu::with_items(app, "View", true, &[&item])?)?;
    }
    app.on_menu_event(|app, event| {
        if event.id().as_ref() != "debug.inspector" {
            return;
        }
        let window = app
            .webview_windows()
            .into_values()
            .find(|window| window.is_focused().unwrap_or(false))
            .or_else(|| app.get_webview_window("main"));
        if let Some(window) = window {
            if window.is_devtools_open() {
                window.close_devtools();
            } else {
                window.open_devtools();
            }
        }
    });
    Ok(())
}

fn main_focused(app: &AppHandle) -> bool {
    app.get_webview_window("main")
        .is_some_and(|window| window.is_focused().unwrap_or(false))
}

pub(crate) fn focused(app: &AppHandle, label: &str) {
    let Some(menu) = app.try_state::<ReviewMenu>() else {
        return;
    };
    let enabled = label == "main" && menu.context.lock().is_some();
    let _ = menu.submenu.set_enabled(enabled);
}

impl ReviewMenu {
    fn apply(&self, app: &AppHandle, context: Option<ReviewMenuState>) -> tauri::Result<()> {
        if *self.context.lock() == context {
            return Ok(());
        }
        *self.context.lock() = None;
        self.submenu.set_enabled(false)?;
        while self.submenu.remove_at(0)?.is_some() {}
        if let Some(context) = &context {
            let status = match context.status {
                PublicationStatus::Draft => "Local draft",
                PublicationStatus::CompletedLocal => "Completed · local",
                PublicationStatus::PublicationPending => "Publication pending",
                PublicationStatus::Published => "Published",
                PublicationStatus::Archived => "Archived in Git",
            };
            self.submenu
                .append(&MenuItem::new(app, status, false, None::<&str>)?)?;
            self.submenu.append(&PredefinedMenuItem::separator(app)?)?;
            for entry in &context.entries {
                if entry.action == ReviewMenuAction::Details {
                    self.submenu.append(&PredefinedMenuItem::separator(app)?)?;
                }
                let id = action_id(entry.action);
                if entry.action == ReviewMenuAction::KeepLocal {
                    self.submenu.append(&CheckMenuItem::with_id(
                        app,
                        id,
                        "Keep this review local",
                        entry.enabled,
                        context.keep_local,
                        None::<&str>,
                    )?)?;
                } else {
                    let (label, icon) = action_presentation(entry.action, context.update_with_rev);
                    #[cfg(target_os = "macos")]
                    let item = IconMenuItem::with_id_and_native_icon(
                        app,
                        id,
                        label,
                        entry.enabled,
                        Some(icon),
                        None::<&str>,
                    )?;
                    #[cfg(not(target_os = "macos"))]
                    let item = {
                        let _ = icon;
                        IconMenuItem::with_id(app, id, label, entry.enabled, None, None::<&str>)?
                    };
                    self.submenu.append(&item)?;
                }
            }
        } else {
            self.submenu
                .append(&MenuItem::new(app, "No review open", false, None::<&str>)?)?;
        }
        #[cfg(target_os = "macos")]
        macos::show_review_icons();
        let enabled = context.is_some() && main_focused(app);
        *self.context.lock() = context;
        self.submenu.set_enabled(enabled)
    }
}

fn action_id(action: ReviewMenuAction) -> &'static str {
    match action {
        ReviewMenuAction::Refresh => "review.refresh",
        ReviewMenuAction::CompleteManual => "review.completeManual",
        ReviewMenuAction::CompleteUpdated => "review.completeUpdated",
        ReviewMenuAction::KeepLocal => "review.keepLocal",
        ReviewMenuAction::RetryPublication => "review.retryPublication",
        ReviewMenuAction::Reopen => "review.reopen",
        ReviewMenuAction::Details => "review.details",
        ReviewMenuAction::Summary => "review.summary",
    }
}

fn action_from_id(id: &str) -> Option<ReviewMenuAction> {
    [
        ReviewMenuAction::Refresh,
        ReviewMenuAction::CompleteManual,
        ReviewMenuAction::CompleteUpdated,
        ReviewMenuAction::KeepLocal,
        ReviewMenuAction::RetryPublication,
        ReviewMenuAction::Reopen,
        ReviewMenuAction::Details,
        ReviewMenuAction::Summary,
    ]
    .into_iter()
    .find(|action| action_id(*action) == id)
}

fn action_presentation(
    action: ReviewMenuAction,
    update_with_rev: bool,
) -> (&'static str, NativeIcon) {
    match action {
        ReviewMenuAction::Refresh => (
            if update_with_rev {
                "Update with Rev"
            } else {
                "Refresh"
            },
            NativeIcon::Refresh,
        ),
        ReviewMenuAction::CompleteManual => ("Complete review", NativeIcon::MenuOnState),
        ReviewMenuAction::CompleteUpdated => ("Complete updated review", NativeIcon::MenuOnState),
        ReviewMenuAction::KeepLocal => ("Keep this review local", NativeIcon::Computer),
        ReviewMenuAction::RetryPublication => ("Retry publication", NativeIcon::Share),
        ReviewMenuAction::Reopen => ("Review again", NativeIcon::RefreshFreestanding),
        ReviewMenuAction::Details => ("Review details", NativeIcon::Info),
        ReviewMenuAction::Summary => ("Review summary", NativeIcon::ListView),
    }
}

#[tauri::command]
pub(crate) async fn configure_review_menu(
    app: AppHandle,
    window: tauri::WebviewWindow,
    context: Option<ReviewMenuState>,
) -> AppResult<()> {
    if window.label() != "main" {
        return Err(AppError::new(
            "window",
            "The review menu belongs to the main reader",
        ));
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let owner = app.clone();
    app.run_on_main_thread(move || {
        let result = owner.state::<ReviewMenu>().apply(&owner, context);
        let _ = sender.send(result);
    })
    .map_err(|error| AppError::new("menu", error.to_string()))?;
    receiver
        .await
        .map_err(|error| AppError::new("menu", error.to_string()))?
        .map_err(|error| AppError::new("menu", error.to_string()))
}
