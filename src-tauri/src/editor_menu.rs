use crate::contracts::{AppError, AppResult};
use parking_lot::Mutex;
use tauri::{
    AppHandle, Emitter, Manager,
    menu::{CheckMenuItem, Menu, MenuItem, Submenu},
};

pub(crate) struct EditorMenu {
    submenu: Submenu<tauri::Wry>,
    ignored: CheckMenuItem<tauri::Wry>,
    auto_save: CheckMenuItem<tauri::Wry>,
    save_all: MenuItem<tauri::Wry>,
    repository: Mutex<Option<String>>,
}

pub(crate) fn install(app: &AppHandle, menu: &Menu<tauri::Wry>) -> tauri::Result<()> {
    let ignored = CheckMenuItem::with_id(
        app,
        "editor.ignored",
        "Show ignored files",
        false,
        true,
        None::<&str>,
    )?;
    let view = menu.items()?.into_iter().find_map(|item| {
        let submenu = item.as_submenu()?;
        (submenu.text().ok()?.as_str() == "View").then(|| submenu.clone())
    });
    if let Some(view) = view {
        view.append(&ignored)?;
    } else {
        menu.append(&Submenu::with_items(app, "View", true, &[&ignored])?)?;
    }
    let auto_save = CheckMenuItem::with_id(
        app,
        "editor.autoSave",
        "Auto save",
        false,
        false,
        None::<&str>,
    )?;
    let save_all = MenuItem::with_id(
        app,
        "editor.saveAll",
        "Save all",
        false,
        Some("CmdOrCtrl+Shift+S"),
    )?;
    let submenu = Submenu::with_items(app, "Editor", false, &[&auto_save, &save_all])?;
    let position = menu
        .items()?
        .iter()
        .position(|item| item.id().as_ref() == "review")
        .unwrap_or(menu.items()?.len());
    menu.insert(&submenu, position)?;
    app.manage(EditorMenu {
        submenu,
        ignored,
        auto_save,
        save_all,
        repository: Mutex::new(None),
    });
    app.on_menu_event(|app, event| {
        let id = event.id().as_ref();
        if !matches!(id, "editor.ignored" | "editor.autoSave" | "editor.saveAll") {
            return;
        }
        let menu = app.state::<EditorMenu>();
        if !menu.submenu.is_enabled().unwrap_or(false) {
            return;
        }
        // WebView state owns these preferences; restore until its update arrives.
        let item = match id {
            "editor.ignored" => Some(&menu.ignored),
            "editor.autoSave" => Some(&menu.auto_save),
            _ => None,
        };
        if let Some(item) = item {
            let _ = item.set_checked(!item.is_checked().unwrap_or(false));
        }
        if let Some(repository) = menu.repository.lock().clone() {
            let _ = app.emit_to("main", "reviewbox:editor-menu", (repository, id));
        }
    });
    Ok(())
}

pub(crate) fn focused(app: &AppHandle, label: &str) {
    if let Some(menu) = app.try_state::<EditorMenu>() {
        let enabled = label == "main" && menu.repository.lock().is_some();
        let _ = menu.submenu.set_enabled(enabled);
        let _ = menu.ignored.set_enabled(enabled);
    }
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
            let enabled = repository_id.is_some()
                && owner
                    .get_webview_window("main")
                    .is_some_and(|w| w.is_focused().unwrap_or(false));
            *menu.repository.lock() = repository_id;
            menu.ignored.set_checked(show_ignored)?;
            menu.auto_save.set_checked(auto_save)?;
            menu.auto_save
                .set_enabled(menu.repository.lock().is_some())?;
            menu.save_all.set_enabled(can_save)?;
            menu.ignored.set_enabled(enabled)?;
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
