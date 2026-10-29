use crate::contracts::{AppError, AppResult};
use parking_lot::Mutex;
use tauri::{
    AppHandle, Emitter, Manager,
    menu::{CheckMenuItem, Menu, MenuItem, Submenu},
};

const IGNORED: &str = "editor.ignored";
const AUTO_SAVE: &str = "editor.autoSave";
const SAVE_ALL: &str = "editor.saveAll";

#[derive(Clone)]
struct EditorItems {
    ignored: CheckMenuItem<tauri::Wry>,
    auto_save: CheckMenuItem<tauri::Wry>,
    save_all: MenuItem<tauri::Wry>,
    repository: Option<String>,
}
#[derive(Clone)]
struct EditorMenuState {
    items: EditorItems,
    // The last checkout remains attached to its native IDs while the editor is
    // hidden. Focus must use this explicit flag rather than its presence.
    active: bool,
    show_ignored: bool,
    auto_save: bool,
}
pub(crate) struct EditorMenu {
    submenu: Submenu<tauri::Wry>,
    view: Submenu<tauri::Wry>,
    state: Mutex<EditorMenuState>,
}

fn item_id(action: &str, repository: Option<&str>) -> String {
    repository.map_or_else(
        || action.to_owned(),
        |repository| format!("{action}:{repository}"),
    )
}
/// A queued native click retains the checkout that owned the clicked item.
/// Never route it using the currently displayed checkout or current focus.
fn route(id: &str) -> Option<(&str, &str)> {
    let (action, repository) = id.split_once(':')?;
    (!repository.is_empty() && matches!(action, IGNORED | AUTO_SAVE | SAVE_ALL))
        .then_some((repository, action))
}
fn restore_checked(clicked_id: &str, current_id: &str, checked: bool) -> Option<bool> {
    (clicked_id == current_id).then_some(checked)
}
fn enabled(active: bool, window: &str) -> bool {
    active && window == "main"
}
fn create_items(app: &AppHandle, repository: Option<&str>) -> tauri::Result<EditorItems> {
    Ok(EditorItems {
        ignored: CheckMenuItem::with_id(
            app,
            item_id(IGNORED, repository),
            "Show ignored files",
            false,
            true,
            None::<&str>,
        )?,
        auto_save: CheckMenuItem::with_id(
            app,
            item_id(AUTO_SAVE, repository),
            "Auto save",
            false,
            false,
            None::<&str>,
        )?,
        save_all: MenuItem::with_id(
            app,
            item_id(SAVE_ALL, repository),
            "Save all",
            false,
            Some("CmdOrCtrl+Shift+S"),
        )?,
        repository: repository.map(str::to_owned),
    })
}

pub(crate) fn install(app: &AppHandle, menu: &Menu<tauri::Wry>) -> tauri::Result<()> {
    let items = create_items(app, None)?;
    let view = menu.items()?.into_iter().find_map(|item| {
        let submenu = item.as_submenu()?;
        (submenu.text().ok()?.as_str() == "View").then(|| submenu.clone())
    });
    let view = if let Some(view) = view {
        view.append(&items.ignored)?;
        view
    } else {
        let view = Submenu::with_items(app, "View", true, &[&items.ignored])?;
        menu.append(&view)?;
        view
    };
    let submenu = Submenu::with_items(app, "Editor", false, &[&items.auto_save, &items.save_all])?;
    let position = menu
        .items()?
        .iter()
        .position(|item| item.id().as_ref() == "review")
        .unwrap_or(menu.items()?.len());
    menu.insert(&submenu, position)?;
    app.manage(EditorMenu {
        submenu,
        view,
        state: Mutex::new(EditorMenuState {
            items,
            active: false,
            show_ignored: true,
            auto_save: false,
        }),
    });
    app.on_menu_event(|app, event| {
        let id = event.id().as_ref();
        let Some((repository, action)) = route(id) else {
            return;
        };
        let menu = app.state::<EditorMenu>();
        let state = menu.state.lock().clone();
        // Native UI calls may marshal to the main thread: no state lock is held.
        // Only restore the clicked item if it still belongs to the active set;
        // a delayed click for checkout A must never toggle checkout B's item.
        let item = match action {
            IGNORED => Some((&state.items.ignored, state.show_ignored)),
            AUTO_SAVE => Some((&state.items.auto_save, state.auto_save)),
            _ => None,
        };
        if let Some((item, checked)) = item
            && let Some(checked) = restore_checked(id, item.id().as_ref(), checked)
        {
            let _ = item.set_checked(checked);
        }
        let _ = app.emit_to("main", "reviewbox:editor-menu", (repository, action));
    });
    Ok(())
}

pub(crate) fn focused(app: &AppHandle, label: &str) {
    let owner = app.clone();
    let label = label.to_owned();
    let _ = app.run_on_main_thread(move || {
        if let Some(menu) = owner.try_state::<EditorMenu>() {
            let state = menu.state.lock().clone();
            let enabled = enabled(state.active, &label);
            let _ = menu.submenu.set_enabled(enabled);
            let _ = state.items.ignored.set_enabled(enabled);
        }
    });
}

#[tauri::command]
pub(crate) async fn configure_editor_menu(
    app: AppHandle,
    window: tauri::WebviewWindow,
    repository_id: Option<String>,
    show_ignored: bool,
    auto_save: bool,
    can_save: bool,
) -> AppResult<()> {
    if window.label() != "main" {
        return Err(AppError::new(
            "window",
            "The editor menu belongs to the main window.",
        ));
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let owner = app.clone();
    app.run_on_main_thread(move || {
        let result = (|| -> tauri::Result<()> {
            let menu = owner.state::<EditorMenu>();
            let mut state = menu.state.lock().clone();
            state.active = repository_id.is_some();
            if let Some(repository) = repository_id.as_deref() {
                if state.items.repository.as_deref() != Some(repository) {
                    let items = create_items(&owner, Some(repository))?;
                    let position = menu
                        .view
                        .items()?
                        .iter()
                        .position(|item| item.id() == state.items.ignored.id())
                        .unwrap_or(menu.view.items()?.len());
                    menu.view.remove(&state.items.ignored)?;
                    menu.view.insert(&items.ignored, position)?;
                    menu.submenu.remove(&state.items.auto_save)?;
                    menu.submenu.remove(&state.items.save_all)?;
                    menu.submenu.append(&items.auto_save)?;
                    menu.submenu.append(&items.save_all)?;
                    state.items = items;
                }
                state.show_ignored = show_ignored;
                state.auto_save = auto_save;
            }
            let enabled = state.active
                && owner
                    .get_webview_window("main")
                    .is_some_and(|w| w.is_focused().unwrap_or(false));
            // Publish the scope/visibility atomically; mutate native handles only
            // after dropping the lock so callbacks cannot deadlock on the UI.
            *menu.state.lock() = state.clone();
            state.items.ignored.set_checked(state.show_ignored)?;
            state.items.auto_save.set_checked(state.auto_save)?;
            state.items.auto_save.set_enabled(state.active)?;
            state.items.save_all.set_enabled(state.active && can_save)?;
            state.items.ignored.set_enabled(enabled)?;
            menu.submenu.set_enabled(enabled)
        })();
        let _ = sender.send(result);
    })
    .map_err(|e| AppError::new("menu", e.to_string()))?;
    receiver
        .await
        .map_err(|e| AppError::new("menu", e.to_string()))?
        .map_err(|e| AppError::new("menu", e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn queued_actions_keep_their_checkout_after_hide_or_checkout_switch() {
        for action in [AUTO_SAVE, SAVE_ALL, IGNORED] {
            let clicked = item_id(action, Some("checkout:a"));
            let replacement = item_id(action, Some("checkout:b"));
            assert_eq!(route(&clicked), Some(("checkout:a", action)));
            assert_eq!(route(&replacement), Some(("checkout:b", action)));
            assert_eq!(restore_checked(&clicked, &replacement, false), None);
            assert_eq!(restore_checked(&clicked, &clicked, true), Some(true));
            assert_eq!(route(&item_id(action, None)), None);
        }
        assert_eq!(route("editor.autoSave:"), None);
        assert_eq!(route("review.action:checkout:a"), None);
    }
    #[test]
    fn focus_never_reactivates_a_hidden_editor_with_retained_items() {
        assert!(!enabled(false, "main"));
        assert!(!enabled(true, "settings"));
        assert!(enabled(true, "main"));
    }
}
