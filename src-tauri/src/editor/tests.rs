use super::*;

#[test]
fn save_preserves_bytes_permissions_and_rejects_external_changes() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    fs::write(root.join("a.ts"), b"\xef\xbb\xbflet a = 1;\r\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(root.join("a.ts"), fs::Permissions::from_mode(0o755)).unwrap();
    }
    let file = read(root, "a.ts").unwrap();
    assert_eq!(file.text, "let a = 1;\r\n");
    mutate(
        root,
        EditorMutation::Save {
            path: "a.ts".into(),
            text: "let a = 2;\n".into(),
            expected_revision: file.revision.clone(),
        },
    )
    .unwrap();
    assert_eq!(
        fs::read(root.join("a.ts")).unwrap(),
        b"\xef\xbb\xbflet a = 2;\r\n"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(root.join("a.ts"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o755
        );
    }
    assert_eq!(
        mutate(
            root,
            EditorMutation::Save {
                path: "a.ts".into(),
                text: "lost update".into(),
                expected_revision: file.revision
            }
        )
        .unwrap_err()
        .code,
        "editor_conflict"
    );
    assert_eq!(read(root, "a.ts").unwrap().text, "let a = 2;\r\n");
}

#[test]
fn inventory_includes_empty_folders_and_honors_gitignore() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    std::process::Command::new("git")
        .args(["init", "-q"])
        .current_dir(root)
        .status()
        .unwrap();
    fs::write(root.join(".gitignore"), "ignored/\n").unwrap();
    fs::create_dir(root.join("empty")).unwrap();
    fs::create_dir(root.join("ignored")).unwrap();
    fs::write(root.join("ignored/data"), "private").unwrap();
    let entries = inventory(root, false).unwrap();
    assert!(entries.iter().any(|e| e.path == "empty" && e.directory));
    assert!(
        !entries
            .iter()
            .any(|e| e.path.starts_with("ignored") || e.path.starts_with(".git/"))
    );
    assert!(
        inventory(root, true)
            .unwrap()
            .iter()
            .any(|e| e.path == "ignored/data")
    );
}

#[test]
fn mutations_reject_escape_collisions_and_stale_directory_revisions() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    for p in [
        "../escape",
        "/tmp/escape",
        ".git/config",
        ".reviewbox/settings.json",
        "a/../b",
    ] {
        assert!(path(root, p).is_err(), "{p}");
    }
    mutate(
        root,
        EditorMutation::Create {
            path: "a".into(),
            directory: true,
        },
    )
    .unwrap();
    let previous = revision(&root.join("a")).unwrap();
    fs::write(root.join("a/file"), "new").unwrap();
    assert!(
        mutate(
            root,
            EditorMutation::Rename {
                path: "a".into(),
                destination: "b".into(),
                expected_revision: previous
            }
        )
        .is_err()
    );
    let expected_revision = revision(&root.join("a")).unwrap();
    mutate(
        root,
        EditorMutation::Rename {
            path: "a".into(),
            destination: "b".into(),
            expected_revision,
        },
    )
    .unwrap();
    assert_eq!(fs::read_to_string(root.join("b/file")).unwrap(), "new");
    assert!(
        mutate(
            root,
            EditorMutation::Create {
                path: "b/file".into(),
                directory: false
            }
        )
        .is_err()
    );
}

#[cfg(unix)]
#[test]
fn symlink_and_binary_sources_cannot_be_overwritten() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    std::os::unix::fs::symlink("/tmp", root.join("link")).unwrap();
    assert!(path(root, "link/escape").is_err());
    fs::write(root.join("binary"), [0, 255, 1]).unwrap();
    let file = read(root, "binary").unwrap();
    assert!(file.read_only);
    assert!(
        mutate(
            root,
            EditorMutation::Save {
                path: "binary".into(),
                text: "wrong".into(),
                expected_revision: file.revision
            }
        )
        .is_err()
    );
}

#[test]
fn preserves_mixed_newlines_and_does_not_touch_the_index() {
    assert_eq!(
        preserve_line_endings("first\rsecond\nthird\r\n", "first\nchanged\nthird\n"),
        "first\rchanged\nthird\r\n"
    );
    assert_eq!(
        preserve_line_endings("a\r\nb\nc\r\n", "a\nb\nnew\nc\n"),
        "a\r\nb\nnew\r\nc\r\n"
    );
    assert_eq!(
        preserve_line_endings("first\r\nsecond\nthird\r\n", "first\nchanged\nthird\n"),
        "first\r\nchanged\nthird\r\n"
    );
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    std::process::Command::new("git")
        .args(["init", "-q"])
        .current_dir(root)
        .status()
        .unwrap();
    fs::write(root.join("file"), "before\n").unwrap();
    std::process::Command::new("git")
        .args(["add", "file"])
        .current_dir(root)
        .status()
        .unwrap();
    let index = fs::read(root.join(".git/index")).unwrap();
    let file = read(root, "file").unwrap();
    mutate(
        root,
        EditorMutation::Save {
            path: "file".into(),
            text: "after\n".into(),
            expected_revision: file.revision,
        },
    )
    .unwrap();
    assert_eq!(fs::read(root.join(".git/index")).unwrap(), index);
}
