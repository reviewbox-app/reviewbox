fn main() {
    let manifest = tauri_build::AppManifest::new().commands(&["get_app_info"]);

    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("failed to build ReviewBox application metadata");
}
