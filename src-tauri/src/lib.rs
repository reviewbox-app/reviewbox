mod app_info;

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![app_info::get_app_info])
        .run(tauri::generate_context!())
        .expect("failed to run ReviewBox");
}
