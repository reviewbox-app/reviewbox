use serde::Serialize;

/// Public application metadata shared with the frontend over Tauri IPC.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppInfo {
    name: String,
    version: String,
}

// This command only copies in-memory package metadata; it does not perform I/O.
#[tauri::command]
pub(crate) fn get_app_info(app: tauri::AppHandle) -> AppInfo {
    let package = app.package_info();

    AppInfo {
        name: package.name.clone(),
        version: package.version.to_string(),
    }
}
