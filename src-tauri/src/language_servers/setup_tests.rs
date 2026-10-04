use super::*;
fn plan() -> LanguageSetupPlan {
    LanguageSetupPlan {
        id: "test-plan".into(),
        repository_id: "test".into(),
        path: "main.ts".into(),
        summary: "Use project compiler settings".into(),
        prerequisites: vec![],
        pack: None,
        server_id: Some("typescript".into()),
        server: None,
        files: vec![LanguageSetupFile {
            path: "tsconfig.json".into(),
            before: Some("{}".into()),
            after: "{\"compilerOptions\":{\"strict\":true}}".into(),
            expected_revision: None,
        }],
        commands: vec![],
    }
}
#[test]
fn preparing_or_rejecting_a_plan_cannot_change_project_files() {
    let temp = tempfile::tempdir().unwrap();
    let storage = Storage::open(temp.path().join("private")).unwrap();
    let root = temp.path().join("repo");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("tsconfig.json"), "{}").unwrap();
    let mut p = plan();
    validate_plan(&storage, &root, &mut p).unwrap();
    assert_eq!(p.files[0].expected_revision, Some(fingerprint(b"{}")));
    assert_eq!(
        fs::read_to_string(root.join("tsconfig.json")).unwrap(),
        "{}"
    );
    assert!(
        catalog::installed(&storage, "typescript")
            .unwrap()
            .is_none()
    );
    fs::write(root.join("tsconfig.json"), "external change").unwrap();
    assert_eq!(
        validate_plan(&storage, &root, &mut p).unwrap_err().code,
        "stale_plan"
    );
    p.files[0].path = "../outside".into();
    assert!(validate_plan(&storage, &root, &mut p).is_err());
}
#[test]
fn interrupted_execution_keeps_an_uncertain_command_and_completed_steps() {
    let temp = tempfile::tempdir().unwrap();
    let storage = Storage::open(temp.path().join("private")).unwrap();
    let status = LanguageSetupStatus {
        id: "test-plan".into(),
        phase: "applying".into(),
        message: "running".into(),
        completed_steps: vec!["Installed typescript".into()],
        plan: Some(plan()),
        revisions: Default::default(),
        in_flight_command: Some(0),
        log: String::new(),
    };
    persist(&storage, &status).unwrap();
    let recovered = recover_status(&storage, &Setup::default(), "test-plan").unwrap();
    assert_eq!(recovered.phase, "interrupted");
    assert_eq!(recovered.in_flight_command, Some(0));
    assert_eq!(recovered.completed_steps, status.completed_steps);
    assert!(read_status(&storage, "../escape").is_err());
}
#[test]
fn approved_recipes_are_frozen_and_changed_pack_versions_require_a_new_plan() {
    let temp = tempfile::tempdir().unwrap();
    let storage = Storage::open(temp.path().join("private")).unwrap();
    let mut pack: LanguagePack = serde_json::from_value(json!({
        "id":"custom-server", "name":"Custom server", "version":"1.0.0", "sourceUrl":"https://example.org/language",
        "languages":[{"id":"custom","name":"Custom","lspId":"custom","extensions":["custom"]}],
        "rootMarkers":[],"grammars":[],"enabled":true,
        "server":{"installation":{"kind":"executable","executable":"custom-lsp"},"arguments":["--stdio"],"settings":{}}
    })).unwrap();
    packs::save(&storage, &pack).unwrap();
    let mut plan = plan();
    plan.server_id = Some(pack.id.clone());
    plan.server = server_snapshot(&storage, &plan).unwrap();
    check_server_snapshot(&storage, &plan).unwrap();
    let recipe: super::super::install::InstallationRecipe =
        serde_json::from_value(plan.server.as_ref().unwrap().recipe.clone()).unwrap();
    pack.version = "2.0.0".into();
    pack.server.as_mut().unwrap().arguments = vec!["--changed".into()];
    packs::save(&storage, &pack).unwrap();
    assert_eq!(
        check_server_snapshot(&storage, &plan).unwrap_err().code,
        "stale_plan"
    );
    assert_eq!(recipe.server.version, "1.0.0");
    assert_eq!(recipe.server.arguments, ["--stdio"]);
    assert!(catalog::installed(&storage, &pack.id).unwrap().is_none());
    plan.server = server_snapshot(&storage, &plan).unwrap();
    pack.server.as_mut().unwrap().settings = json!({"project":"different"});
    packs::save(&storage, &pack).unwrap();
    assert_eq!(
        check_server_snapshot(&storage, &plan).unwrap_err().code,
        "stale_plan"
    );
}
