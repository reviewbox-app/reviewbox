#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if !reviewbox_lib::run_cli() {
        reviewbox_lib::run()
    };
}
