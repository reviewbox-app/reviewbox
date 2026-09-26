fn main() {
    println!(
        "{}",
        serde_json::to_string_pretty(&reviewbox_lib::project_schemas()).unwrap()
    );
}
