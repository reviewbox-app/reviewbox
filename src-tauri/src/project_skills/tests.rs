use super::*;

fn resources() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../resources/agents")
}
fn report() -> ProjectSkillImport {
    ProjectSkillImport {
        repository_id: "fixture".into(),
        enabled: true,
        created: vec![],
        preserved: vec![],
        error: None,
    }
}

#[test]
fn imports_missing_preserves_edits_and_repairs_missing_files() {
    let root = tempfile::tempdir().unwrap();
    let mut first = report();
    install(root.path(), &resources(), &mut first).unwrap();
    assert_eq!(first.created.len(), 5);
    let target = root
        .path()
        .join(".agents/skills/reviewbox-project/SKILL.md");
    fs::write(&target, "Human changes\n").unwrap();
    let agents = root.path().join("AGENTS.md");
    let customized = fs::read_to_string(&agents)
        .unwrap()
        .replace("## ReviewBox project skills", "## Custom references");
    fs::write(&agents, &customized).unwrap();
    fs::remove_file(root.path().join(".agents/skills/reviewbox-review/SKILL.md")).unwrap();
    let mut second = report();
    install(root.path(), &resources(), &mut second).unwrap();
    assert_eq!(second.created.len(), 1);
    assert_eq!(fs::read_to_string(target).unwrap(), "Human changes\n");
    assert_eq!(fs::read_to_string(agents).unwrap(), customized);
}

#[test]
fn appends_references_once_preserving_bom_crlf_and_permissions() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("AGENTS.md");
    fs::write(&path, "\u{feff}# Existing\r\nKeep this.\r\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
    }
    install(root.path(), &resources(), &mut report()).unwrap();
    install(root.path(), &resources(), &mut report()).unwrap();
    let content = fs::read_to_string(&path).unwrap();
    assert!(content.starts_with("\u{feff}# Existing\r\nKeep this.\r\n"));
    assert_eq!(content.matches(START).count(), 1);
    assert!(!content.replace("\r\n", "").contains('\n'));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o640
        );
    }
}

#[test]
fn disabling_import_preserves_existing_files_and_global_off_wins() {
    let root = tempfile::tempdir().unwrap();
    std::process::Command::new("git")
        .args(["init", "-q"])
        .current_dir(root.path())
        .output()
        .unwrap();
    let data = tempfile::tempdir().unwrap();
    let storage = Storage::open(data.path().join("data")).unwrap();
    let repo = repositories::open(&storage, root.path().to_str().unwrap()).unwrap();
    // Ordinary native reads/open do not import anything.
    assert!(!root.path().join(".agents").exists());
    let settings = configure(
        &storage,
        ProjectSkillPreferences {
            enabled: false,
            projects: [(repo.id.clone(), true)].into(),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(!bootstrap(&storage, &repo, &resources()).unwrap().enabled);
    assert!(!root.path().join(".agents").exists());
    let settings = configure(
        &storage,
        ProjectSkillPreferences {
            enabled: true,
            ..settings
        },
    )
    .unwrap();
    bootstrap(&storage, &repo, &resources()).unwrap();
    configure(
        &storage,
        ProjectSkillPreferences {
            enabled: false,
            ..settings
        },
    )
    .unwrap();
    bootstrap(&storage, &repo, &resources()).unwrap();
    assert!(
        root.path()
            .join(".agents/skills/reviewbox-project/SKILL.md")
            .is_file()
    );
}

#[cfg(unix)]
#[test]
fn refuses_linked_destinations() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(outside.path(), root.path().join(".agents")).unwrap();
    assert_eq!(
        install(root.path(), &resources(), &mut report())
            .unwrap_err()
            .code,
        "external_path"
    );
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
}
