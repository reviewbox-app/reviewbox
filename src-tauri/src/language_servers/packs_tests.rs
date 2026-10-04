use super::*;

fn pack() -> LanguagePack {
    serde_json::from_value(serde_json::json!({
        "id":"example-dsl", "name":"Example DSL", "version":"1.0.0", "sourceUrl":"https://example.org/language",
        "languages":[{"id":"example-dsl","name":"Example DSL","lspId":"example-dsl","extensions":["exdsl"]}],
        "rootMarkers":["example.json"], "server":null,
        "grammars":[{"name":"example-dsl","scopeName":"source.example","patterns":[{"match":"\\bhello\\b","name":"keyword.example"}]}], "enabled":true
    })).unwrap()
}
#[test]
fn a_new_language_is_registered_without_an_installation_or_rebuild() {
    let dir = tempfile::tempdir().unwrap();
    let storage = Storage::open(dir.path().join("private")).unwrap();
    save(&storage, &pack()).unwrap();
    let current = registry(&storage).unwrap();
    assert!(current.languages.iter().any(|l| l.id == "example-dsl"));
    assert!(
        catalog::installed(&storage, "example-dsl")
            .unwrap()
            .is_none()
    );
    let mut disabled = pack();
    disabled.enabled = false;
    save(&storage, &disabled).unwrap();
    assert!(
        !registry(&storage)
            .unwrap()
            .languages
            .iter()
            .any(|l| l.id == "example-dsl")
    );
    assert_eq!(all(&storage).unwrap().len(), 1);
}
#[test]
fn pack_validation_rejects_unsafe_recipes_and_preserves_existing_custom_servers() {
    let mut p = pack();
    p.id = "../../outside".into();
    assert!(validate(&p).is_err());
    let mut p = pack();
    p.id = "typescript".into();
    assert!(validate(&p).is_err());
    let mut p = pack();
    p.server = Some(LanguagePackServer {
        installation: LanguagePackInstallation::Npm {
            package: "--unsafe".into(),
            bin: "server".into(),
        },
        arguments: vec![],
        settings: serde_json::json!({}),
    });
    assert!(validate(&p).is_err());
    let mut p = pack();
    p.root_markers = vec!["../outside".into()];
    assert!(validate(&p).is_err());
}
#[test]
fn shared_registry_resolves_names_patterns_and_shebangs() {
    let languages = builtin_languages();
    for (path, line, expected) in [
        ("ops/Dockerfile.dev", None, "dockerfile"),
        ("tsconfig.app.json", None, "jsonc"),
        (".env.production", None, "dotenv"),
        ("Gemfile", None, "ruby"),
        ("src/file.TSX", None, "tsx"),
        ("run", Some("#!/usr/bin/env python3.13"), "python"),
    ] {
        assert_eq!(
            detect_language(&languages, path, line).unwrap().id,
            expected
        );
    }
    let mut custom = pack().languages;
    custom[0].filenames = vec!["Project.*.example".into()];
    custom[0].interpreters = vec!["example*".into()];
    assert!(detect_language(&custom, "Project.dev.example", None).is_some());
    assert!(detect_language(&custom, "run", Some("#!/usr/bin/env example1")).is_some());
    assert!(detect_language(&custom, "run", Some("#!/usr/bin/env unrelated")).is_none());
}
