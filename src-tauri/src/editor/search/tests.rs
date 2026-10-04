use super::*;
use std::fs;

fn checkout() -> tempfile::TempDir {
    let temp = tempfile::tempdir().unwrap();
    let status = std::process::Command::new("git")
        .args(["init", "-q"])
        .current_dir(temp.path())
        .status()
        .unwrap();
    assert!(status.success());
    temp
}

fn search(root: &Path, query: &str, limits: Limits) -> EditorSearchResult {
    scan(
        root,
        query,
        "request".into(),
        &AtomicBool::new(false),
        limits,
    )
    .unwrap()
}

#[test]
fn excludes_ignored_metadata_links_binary_and_unsupported_text() {
    let temp = checkout();
    let root = temp.path();
    fs::write(root.join(".gitignore"), "ignored/\n").unwrap();
    fs::create_dir(root.join("ignored")).unwrap();
    fs::write(root.join("ignored/secret"), "needle").unwrap();
    fs::write(root.join(".ignore"), "custom-ignored\n").unwrap();
    fs::write(root.join("custom-ignored"), "needle").unwrap();
    fs::write(root.join(".git/info/exclude"), "locally-ignored\n").unwrap();
    fs::write(root.join("locally-ignored"), "needle").unwrap();
    fs::create_dir(root.join(".reviewbox")).unwrap();
    fs::write(root.join(".reviewbox/data"), "needle").unwrap();
    fs::write(root.join(".git/private"), "needle").unwrap();
    fs::write(root.join(".hidden-source"), "needle").unwrap();
    fs::write(root.join("binary"), b"needle\0").unwrap();
    fs::write(root.join("encoding"), b"needle\xff").unwrap();
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(root.join(".hidden-source"), root.join("link")).unwrap();
        std::os::unix::fs::symlink(root.join("ignored"), root.join("linked-folder")).unwrap();
    }
    let result = search(root, "needle", Limits::default());
    assert_eq!(result.matches.len(), 1);
    assert_eq!(result.matches[0].path, ".hidden-source");
    assert_eq!(result.skipped_files, 2);
    assert!(!result.truncated);
    assert!(!result.cancelled);
}

#[test]
fn literal_case_insensitive_matches_use_editor_line_and_utf16_columns() {
    let temp = checkout();
    fs::write(
        temp.path().join("source.ts"),
        "\u{feff}😀 é A.B aXb a.b\r\nsecond\rA.b",
    )
    .unwrap();
    let result = search(temp.path(), "a.b", Limits::default());
    assert_eq!(result.matches.len(), 3);
    assert_eq!(result.matches[0].line, 1);
    assert_eq!(result.matches[0].column, 6);
    assert_eq!(result.matches[0].length, 3);
    assert_eq!(result.matches[0].preview_column, 6);
    assert_eq!(result.matches[1].column, 14);
    assert_eq!(result.matches[2].line, 3);
    assert_eq!(result.matches[2].column, 1);
}

#[test]
fn preview_bounds_long_lines_without_splitting_unicode_or_losing_match() {
    let temp = checkout();
    let text = format!("{}Needle{}", "😀".repeat(2_000), "é".repeat(2_000));
    fs::write(temp.path().join("long"), text).unwrap();
    let result = search(temp.path(), "needle", Limits::default());
    let found = &result.matches[0];
    assert_eq!(found.column, 4_001);
    assert!(found.preview.chars().count() < 240);
    assert!(found.preview.starts_with('…'));
    assert!(found.preview.ends_with('…'));
    assert_eq!(
        String::from_utf16(
            &found.preview.encode_utf16().collect::<Vec<_>>()[found.preview_column as usize - 1..]
                [..found.length as usize]
        )
        .unwrap(),
        "Needle"
    );
}

#[test]
fn per_file_limit_keeps_scanning_other_files_and_total_limit_is_explicit() {
    let temp = checkout();
    fs::write(temp.path().join("a"), "x x x x").unwrap();
    fs::write(temp.path().join("b"), "x x x x").unwrap();
    let limits = Limits {
        file_matches: 2,
        ..Limits::default()
    };
    let result = search(temp.path(), "x", limits);
    assert_eq!(result.matches.len(), 4);
    assert_eq!(result.matches.iter().filter(|m| m.path == "a").count(), 2);
    assert_eq!(result.matches.iter().filter(|m| m.path == "b").count(), 2);
    assert!(result.truncated);
    let result = search(
        temp.path(),
        "x",
        Limits {
            matches: 1,
            ..limits
        },
    );
    assert_eq!(result.matches.len(), 1);
    assert!(result.truncated);
}

#[test]
fn file_byte_scan_byte_and_time_budgets_report_incomplete_results() {
    let temp = checkout();
    fs::write(temp.path().join("a"), "needle").unwrap();
    let result = search(
        temp.path(),
        "needle",
        Limits {
            file_bytes: 3,
            ..Limits::default()
        },
    );
    assert_eq!(result.skipped_files, 1);
    assert!(result.matches.is_empty());
    let result = search(
        temp.path(),
        "needle",
        Limits {
            total_bytes: 3,
            ..Limits::default()
        },
    );
    assert!(result.truncated);
    assert!(result.matches.is_empty());
    let result = search(
        temp.path(),
        "needle",
        Limits {
            time: Duration::ZERO,
            ..Limits::default()
        },
    );
    assert!(result.truncated);
    assert!(result.matches.is_empty());
}

#[test]
fn latest_request_cancels_previous_and_obsolete_cancel_does_not_cancel_current() {
    let state = SearchState::default();
    let old = state.begin("old".into());
    let current = state.begin("current".into());
    assert!(old.load(Ordering::Relaxed));
    assert!(!current.load(Ordering::Relaxed));
    state.cancel("old");
    state.finish(&old);
    assert!(!current.load(Ordering::Relaxed));
    state.cancel("current");
    assert!(current.load(Ordering::Relaxed));
    let temp = checkout();
    fs::write(temp.path().join("a"), "needle").unwrap();
    let result = scan(temp.path(), "needle", "old".into(), &old, Limits::default()).unwrap();
    assert!(result.cancelled);
    assert!(result.matches.is_empty());
    assert_eq!(result.scanned_files, 0);
}

#[test]
fn empty_and_invalid_queries_never_produce_unbounded_matches() {
    let temp = checkout();
    fs::write(temp.path().join("a"), "a\nb").unwrap();
    let empty = search(temp.path(), "", Limits::default());
    assert!(empty.matches.is_empty());
    assert_eq!(empty.scanned_files, 0);
    for query in ["line\nbreak".into(), "\0".into(), "é".repeat(257)] {
        let error = scan(
            temp.path(),
            &query,
            "invalid".into(),
            &AtomicBool::new(false),
            Limits::default(),
        )
        .unwrap_err();
        assert_eq!(error.code, "search_query");
    }
}
