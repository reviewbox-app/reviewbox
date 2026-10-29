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
        &[],
        None,
        &mut |_| true,
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
fn file_byte_and_scan_byte_budgets_report_incomplete_results() {
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
}

#[test]
fn latest_request_cancels_previous_and_obsolete_cancel_does_not_cancel_current() {
    let state = SearchState::default();
    let owner = ("window".into(), "checkout".into());
    let old = state.begin(owner.clone(), "old".into());
    let current = state.begin(owner.clone(), "current".into());
    assert!(old.load(Ordering::Relaxed));
    assert!(!current.load(Ordering::Relaxed));
    state.cancel(owner.0.clone(), owner.1.clone(), "old".into());
    state.finish(&owner, &old);
    assert!(!current.load(Ordering::Relaxed));
    state.cancel(owner.0.clone(), owner.1.clone(), "current".into());
    assert!(current.load(Ordering::Relaxed));
    let temp = checkout();
    fs::write(temp.path().join("a"), "needle").unwrap();
    let result = scan(
        temp.path(),
        "needle",
        "old".into(),
        &old,
        Limits::default(),
        &[],
        None,
        &mut |_| true,
    )
    .unwrap();
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
            &[],
            None,
            &mut |_| true,
        )
        .unwrap_err();
        assert_eq!(error.code, "search_query");
    }
}

#[test]
fn streams_results_and_unsaved_buffers_replace_disk_without_duplicates() {
    let temp = checkout();
    fs::write(temp.path().join("a.rs"), "disk value").unwrap();
    fs::write(temp.path().join("b.rs"), "needle").unwrap();
    fs::write(temp.path().join(".gitignore"), "secret.rs\n").unwrap();
    let buffers = vec![
        EditorSearchBuffer {
            path: "a.rs".into(),
            version: 3,
            text: "needle unsaved".into(),
        },
        EditorSearchBuffer {
            path: "secret.rs".into(),
            version: 2,
            text: "needle ignored".into(),
        },
    ];
    let mut batches = Vec::new();
    let result = scan(
        temp.path(),
        "needle",
        "stream".into(),
        &AtomicBool::new(false),
        Limits::default(),
        &buffers,
        None,
        &mut |batch| {
            batches.push(batch);
            true
        },
    )
    .unwrap();
    assert_eq!(result.matches.len(), 2);
    assert_eq!(result.matches[0].path, "a.rs");
    assert_eq!(batches.iter().map(|b| b.matches.len()).sum::<usize>(), 2);
    assert!(
        batches
            .iter()
            .enumerate()
            .all(|(i, b)| b.sequence == i as u32 + 1 && b.request_id == "stream")
    );
    let result = scan(
        temp.path(),
        "disk",
        "replacement".into(),
        &AtomicBool::new(false),
        Limits::default(),
        &buffers,
        None,
        &mut |_| true,
    )
    .unwrap();
    assert!(result.matches.is_empty());
}
#[test]
fn cancellation_is_scoped_to_owner_checkout_and_handles_early_cancel() {
    let state = SearchState::default();
    let a = ("window".into(), "a".into());
    let b = ("window".into(), "b".into());
    let a1 = state.begin(a.clone(), "first".into());
    let b1 = state.begin(b.clone(), "first".into());
    state.cancel(a.0.clone(), a.1.clone(), "first".into());
    assert!(a1.load(Ordering::Acquire));
    assert!(!b1.load(Ordering::Acquire));
    state.cancel(a.0.clone(), a.1.clone(), "early".into());
    assert!(state.begin(a, "early".into()).load(Ordering::Acquire));
}
#[test]
fn channel_cancellation_and_targeted_results_are_bounded() {
    let temp = checkout();
    for file in ["a", "b"] {
        fs::write(temp.path().join(file), "needle").unwrap();
    }
    let cancelled = scan(
        temp.path(),
        "needle",
        "cancel".into(),
        &AtomicBool::new(false),
        Limits::default(),
        &[],
        None,
        &mut |_| false,
    )
    .unwrap();
    assert!(cancelled.cancelled && cancelled.matches.is_empty());
    let result = scan(
        temp.path(),
        "needle",
        "target".into(),
        &AtomicBool::new(false),
        Limits::default(),
        &[],
        Some(&["a".into()]),
        &mut |_| true,
    )
    .unwrap();
    assert_eq!(result.matches.len(), 1);
    assert_eq!(result.matches[0].path, "a");
}

#[test]
fn synthetic_search_delivers_first_batch_before_the_scan_completes() {
    let temp = checkout();
    for folder in 0..10 {
        let dir = temp.path().join(format!("p{folder}"));
        fs::create_dir(&dir).unwrap();
        for file in 0..20 {
            fs::write(dir.join(format!("f{file}.rs")), "needle content\n").unwrap();
        }
    }
    let start = Instant::now();
    let mut first = None;
    let mut batches = 0;
    let result = scan(
        temp.path(),
        "needle",
        "timing".into(),
        &AtomicBool::new(false),
        Limits::default(),
        &[],
        None,
        &mut |batch| {
            first.get_or_insert(start.elapsed());
            batches += 1;
            assert!(!batch.matches.is_empty());
            true
        },
    )
    .unwrap();
    let completed = start.elapsed();
    assert_eq!(result.matches.len(), 200);
    assert!(batches > 1);
    assert!(first.unwrap() <= completed);
    eprintln!(
        "search fixture: first batch {:?}, complete {:?}, {} matches / {} batches / {} scanned files",
        first.unwrap(),
        completed,
        result.matches.len(),
        batches,
        result.scanned_files
    );
}

#[cfg(unix)]
#[test]
fn targeted_search_does_not_open_named_pipes() {
    let temp = checkout();
    assert!(
        std::process::Command::new("mkfifo")
            .arg(temp.path().join("pipe"))
            .status()
            .unwrap()
            .success()
    );
    let result = scan(
        temp.path(),
        "needle",
        "pipe".into(),
        &AtomicBool::new(false),
        Limits::default(),
        &[],
        Some(&["pipe".into()]),
        &mut |_| true,
    )
    .unwrap();
    assert_eq!(result.skipped_files, 0);
    assert!(result.matches.is_empty());
}

#[test]
fn targeted_ignored_directories_stay_excluded() {
    let temp = checkout();
    fs::write(temp.path().join(".gitignore"), "vendor/\n").unwrap();
    fs::create_dir(temp.path().join("vendor")).unwrap();
    fs::write(temp.path().join("vendor/secret"), "needle").unwrap();
    let result = scan(
        temp.path(),
        "needle",
        "ignored".into(),
        &AtomicBool::new(false),
        Limits::default(),
        &[],
        Some(&["vendor".into()]),
        &mut |_| true,
    )
    .unwrap();
    assert!(result.matches.is_empty());
}
#[test]
fn stream_coalesces_small_results_and_flushes_final_remainder() {
    let mut lengths = Vec::new();
    let mut publish = |batch: EditorSearchBatch| {
        lengths.push(batch.matches.len());
        true
    };
    let mut stream = Stream {
        request: "batch".into(),
        sequence: 0,
        from: 0,
        last: Instant::now(),
        publish: &mut publish,
    };
    let mut result = EditorSearchResult::default();
    for index in 0..130 {
        result.matches.push(EditorSearchMatch {
            path: format!("{index}.rs"),
            line: 1,
            column: 1,
            length: 1,
            preview: "x".into(),
            preview_column: 1,
        });
        // Control the clock boundary so this test checks size batching, not machine speed.
        stream.last = Instant::now();
        assert!(stream.flush(&mut result, false));
    }
    assert!(stream.flush(&mut result, true));
    assert_eq!(lengths, [64, 64, 2]);
}

#[test]
fn traversal_budget_bounds_empty_files_and_reports_incomplete_results() {
    let temp = checkout();
    for file in 0..10 {
        fs::write(temp.path().join(format!("empty{file}")), "").unwrap();
    }
    let result = search(
        temp.path(),
        "absent",
        Limits {
            entries: 3,
            ..Limits::default()
        },
    );
    assert!(result.truncated);
    assert!(result.scanned_files <= 3);
    assert!(result.matches.is_empty());
}

#[tokio::test]
async fn cancelled_queued_search_finishes_while_all_workers_are_busy() {
    let state = SearchState::default();
    let permits = state.workers.clone().acquire_many_owned(2).await.unwrap();
    let temp = tempfile::tempdir().unwrap();
    let storage = Storage::open(temp.path().join("data")).unwrap();
    let copy = state.clone();
    let task = tokio::spawn(async move {
        copy.search(
            storage,
            "not-resolved".into(),
            "view".into(),
            "x".into(),
            "queued".into(),
            vec![EditorSearchBuffer {
                path: "a.rs".into(),
                version: 1,
                text: "x".repeat(1_000_000),
            }],
            None,
            Arc::new(|_| true),
        )
        .await
    });
    while state.requests.lock().unwrap().current.is_empty() {
        tokio::task::yield_now().await;
    }
    state.cancel("view".into(), "not-resolved".into(), "queued".into());
    let result = tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(result.cancelled);
    drop(permits);
}
