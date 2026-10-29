use super::*;
use std::process::Command;
fn git(root: &Path, args: &[&str]) {
    let result = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}
fn fixture() -> (tempfile::TempDir, Storage, Repository) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("repo");
    fs::create_dir(&root).unwrap();
    git(&root, &["init", "-q"]);
    git(&root, &["config", "user.email", "tests@example.invalid"]);
    git(&root, &["config", "user.name", "Tests"]);
    for i in 0..100 {
        fs::write(
            root.join(format!("file-{i}.txt")),
            format!("original {i}\nsecond line\n"),
        )
        .unwrap();
    }
    git(&root, &["add", "."]);
    git(
        &root,
        &["-c", "commit.gpgsign=false", "commit", "-qm", "initial"],
    );
    let storage = Storage::open(dir.path().join("data")).unwrap();
    let repository = repositories::open(&storage, root.to_str().unwrap()).unwrap();
    (dir, storage, repository)
}
fn watcher_ready(entry: &Arc<Entry>) {
    ensure_watch(entry);
    let deadline = Instant::now() + Duration::from_secs(5);
    while entry.watcher.lock().unwrap().is_none() {
        assert!(
            Instant::now() < deadline,
            "repository watcher did not start"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn context_reuses_capture_and_refreshes_external_changes() {
    let (_dir, storage, repo) = fixture();
    let root = Path::new(&repo.path);
    let start = Instant::now();
    let first = crate::knowledge::context::load(&storage, repo.id.clone()).unwrap();
    let entry = storage.repository_cache.entry(&storage, root).unwrap();
    watcher_ready(&entry);
    let reads = {
        let data = entry.data.lock().unwrap();
        (data.sources.working_reads, data.sources.object_reads)
    };
    let cold = start.elapsed();
    let start = Instant::now();
    let second = crate::knowledge::context::load(&storage, repo.id.clone()).unwrap();
    assert_eq!(first.id, second.id);
    {
        let data = entry.data.lock().unwrap();
        assert_eq!(
            reads,
            (data.sources.working_reads, data.sources.object_reads)
        );
    }
    eprintln!(
        "Code Explain 100 files: cold {:?}, cached {:?}",
        cold,
        start.elapsed()
    );
    let lease = storage.pin_snapshot(&first.id);
    fs::write(root.join("file-0.txt"), "new content\n").unwrap();
    fs::rename(root.join("file-1.txt"), root.join("renamed.txt")).unwrap();
    fs::remove_file(root.join("file-2.txt")).unwrap();
    let updated = crate::knowledge::context::load(&storage, repo.id.clone()).unwrap();
    assert_ne!(updated.id, first.id);
    assert!(storage.source_context(&first.id).is_ok());
    assert!(updated.files.iter().any(|f| f.path == "renamed.txt"));
    assert!(!updated.files.iter().any(|f| f.path == "file-2.txt"));
    let original = first.files.iter().find(|f| f.path == "file-0.txt").unwrap();
    let current = updated
        .files
        .iter()
        .find(|f| f.path == "file-0.txt")
        .unwrap();
    assert_ne!(original.content.hash, current.content.hash);
    storage.release_context(&first.id).unwrap();
    drop(lease);
    assert!(storage.source_context(&first.id).is_err());
    git(root, &["add", "."]);
    let staged = crate::knowledge::context::load(&storage, repo.id.clone()).unwrap();
    assert!(staged.changes.iter().all(|c| c.layer == "staged"));
}
#[test]
fn metadata_ignored_files_and_explicit_invalidation() {
    let (_dir, storage, repo) = fixture();
    let root = Path::new(&repo.path);
    fs::write(root.join(".gitignore"), "ignored\n").unwrap();
    let before = inventory_fingerprint(root).unwrap();
    fs::write(root.join("ignored"), "output").unwrap();
    fs::write(root.join(".reviewbox/local-test"), "metadata").unwrap();
    assert_eq!(before, inventory_fingerprint(root).unwrap());
    let entry = storage.repository_cache.entry(&storage, root).unwrap();
    let mut data = entry.data.lock().unwrap();
    entry.refresh(root, &mut data).unwrap();
    storage.repository_cache.invalidate(root);
    assert!(entry.refresh(root, &mut data).unwrap());
    let request = storage.repository_cache.begin("test").unwrap();
    storage.repository_cache.cancel("test");
    assert_eq!(request.check().unwrap_err().code, "cancelled");
    storage.repository_cache.finish(&request);
}
#[test]
fn linked_worktree_isolated_and_refs_invalidate() {
    let (dir, storage, repo) = fixture();
    let root = Path::new(&repo.path);
    let second = dir.path().join("worktree");
    git(
        root,
        &["worktree", "add", "-b", "other", second.to_str().unwrap()],
    );
    let other = repositories::open(&storage, second.to_str().unwrap()).unwrap();
    let first = crate::knowledge::context::load(&storage, repo.id.clone()).unwrap();
    let captured = crate::knowledge::context::load(&storage, other.id.clone()).unwrap();
    assert_ne!(first.id, captured.id);
    let before = inventory_fingerprint(&second).unwrap();
    git(root, &["tag", "new-tag"]);
    assert_ne!(before, inventory_fingerprint(&second).unwrap());
    fs::write(second.join("file-0.txt"), "worktree only").unwrap();
    let updated = crate::knowledge::context::load(&storage, other.id.clone()).unwrap();
    assert_ne!(updated.files[0].content.hash, first.files[0].content.hash);
}

#[test]
fn expiration_drops_only_idle_entries_and_preserves_live_source_leases() {
    let (dir, storage, repo) = fixture();
    let root = Path::new(&repo.path);
    let snapshot = crate::knowledge::context::load(&storage, repo.id.clone()).unwrap();
    let lease = storage.pin_snapshot(&snapshot.id);
    {
        let entry = storage.repository_cache.entry(&storage, root).unwrap();
        entry.data.lock().unwrap().touched = Instant::now() - Duration::from_secs(901);
    }
    let other = dir.path().join("other");
    fs::create_dir(&other).unwrap();
    git(&other, &["init", "-q"]);
    let _entry = storage.repository_cache.entry(&storage, &other).unwrap();
    assert!(
        !storage
            .repository_cache
            .entries
            .lock()
            .unwrap()
            .contains_key(root)
    );
    assert!(storage.source_context(&snapshot.id).is_ok());
    drop(lease);
    assert!(storage.source_context(&snapshot.id).is_err());
    // Cancellation delivered before registration is remembered.
    storage.repository_cache.cancel("early");
    let request = storage.repository_cache.begin("early").unwrap();
    assert_eq!(request.check().unwrap_err().code, "cancelled");
    storage.repository_cache.finish(&request);
}

#[test]
fn cached_preview_invalidates_stats_after_external_edit() {
    let (_dir, storage, repo) = fixture();
    let root = Path::new(&repo.path);
    fs::write(root.join("file-0.txt"), "changed\n").unwrap();
    let request = CaptureRequest {
        repository_id: repo.id.clone(),
        scope: Scope::Local,
        base: None,
        target: None,
        include_untracked: true,
    };
    let task = storage.repository_cache.begin("preview").unwrap();
    let start = Instant::now();
    let first =
        crate::review_creation::cached_preview::read(&storage, request.clone(), false, &task)
            .unwrap();
    let inventory = start.elapsed();
    let entry = storage.repository_cache.entry(&storage, root).unwrap();
    watcher_ready(&entry);
    let start = Instant::now();
    let detailed =
        crate::review_creation::cached_preview::read(&storage, request.clone(), true, &task)
            .unwrap();
    let detailed_time = start.elapsed();
    let start = Instant::now();
    let cached =
        crate::review_creation::cached_preview::read(&storage, request.clone(), false, &task)
            .unwrap();
    eprintln!(
        "Preview 100 files: inventory {:?}, details {:?}, cached {:?}",
        inventory,
        detailed_time,
        start.elapsed()
    );
    assert_eq!(first.scopes[0].files, 1);
    assert!(!first.scopes[0].details_ready);
    assert!(cached.scopes[0].details_ready);
    assert_eq!(cached.revision, detailed.revision);
    fs::write(root.join("file-0.txt"), "one\ntwo\nthree\n").unwrap();
    let updated =
        crate::review_creation::cached_preview::read(&storage, request, true, &task).unwrap();
    assert_ne!(updated.revision, cached.revision);
    assert_ne!(updated.scopes[0].additions, cached.scopes[0].additions);
    storage.repository_cache.finish(&task);
}

#[test]
fn explicit_editor_and_git_mutations_do_not_invalidate_unrelated_buffers() {
    let (_dir, storage, repo) = fixture();
    let (sender, receiver) = std::sync::mpsc::channel();
    storage.repository_cache.set_notifier(move |event| {
        sender.send(event).unwrap();
    });
    let root = Path::new(&repo.path);
    let entry = storage.repository_cache.entry(&storage, root).unwrap();
    watcher_ready(&entry);
    storage.repository_cache.notify_editor_mutation(
        root,
        &EditorMutation::Save {
            path: "file-1.txt".into(),
            text: "changed".into(),
            expected_revision: "old".into(),
        },
    );
    let event = receiver.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(event.paths, ["file-1.txt"]);
    assert!(!event.tree && !event.git && !event.full);
    assert_eq!(event.sequence, Some(1));
    {
        let _mutation = storage.repository_cache.git_mutation(root);
    }
    let event = receiver.recv_timeout(Duration::from_secs(3)).unwrap();
    assert!(event.git && !event.tree && !event.full && event.paths.is_empty());
    assert_eq!(event.sequence, Some(2));
    assert!(receiver.try_recv().is_err());
}

#[test]
fn explicit_watch_lease_prevents_cache_eviction_until_released() {
    let (_dir, storage, repo) = fixture();
    let root = Path::new(&repo.path);
    let leased = storage
        .repository_cache
        .lease(&storage, root, "editor")
        .unwrap();
    {
        let entry = storage.repository_cache.entry(&storage, root).unwrap();
        entry.data.lock().unwrap().touched = Instant::now() - Duration::from_secs(901);
    }
    assert_eq!(
        storage
            .repository_cache
            .entry(&storage, root)
            .unwrap()
            .status()
            .generation,
        leased.generation
    );
    storage.repository_cache.release_lease(root, "editor");
    assert_ne!(
        storage
            .repository_cache
            .entry(&storage, root)
            .unwrap()
            .status()
            .generation,
        leased.generation
    );
}

#[test]
fn internal_and_delayed_observations_of_unchanged_bytes_emit_once() {
    let (_dir, storage, repo) = fixture();
    let (sender, receiver) = std::sync::mpsc::channel();
    storage.repository_cache.set_notifier(move |event| {
        let _ = sender.send(event);
    });
    let root = Path::new(&repo.path);
    let entry = storage.repository_cache.entry(&storage, root).unwrap();
    watcher_ready(&entry);
    let mutation = EditorMutation::Save {
        path: "file-1.txt".into(),
        text: "changed".into(),
        expected_revision: "old".into(),
    };
    storage
        .repository_cache
        .notify_editor_mutation(root, &mutation);
    let first = receiver.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(first.paths, ["file-1.txt"]);
    // Models a delayed OS observation arriving after the 200 ms merge window.
    (entry.publish)(RepositoryReadChange {
        full: false,
        git: false,
        tree: false,
        paths: vec!["file-1.txt".into()],
        ..events::full(root)
    });
    assert!(receiver.recv_timeout(Duration::from_millis(350)).is_err());
    fs::write(root.join("file-1.txt"), "new contents").unwrap();
    storage
        .repository_cache
        .notify_editor_mutation(root, &mutation);
    let changed = receiver.recv_timeout(Duration::from_secs(3)).unwrap();
    assert!(changed.paths.contains(&"file-1.txt".to_owned()));
}

#[test]
fn last_consumer_stops_watcher_and_reacquisition_changes_generation() {
    let (_dir, storage, repo) = fixture();
    let root = Path::new(&repo.path);
    let entry = storage.repository_cache.entry(&storage, root).unwrap();
    assert!(entry.watcher.lock().unwrap().is_none());
    let first = storage
        .repository_cache
        .lease(&storage, root, "one")
        .unwrap();
    storage
        .repository_cache
        .lease(&storage, root, "two")
        .unwrap();
    watcher_ready(&entry);
    assert!(storage.repository_cache.release_lease(root, "one").healthy);
    assert!(!storage.repository_cache.release_lease(root, "two").healthy);
    assert!(entry.watcher.lock().unwrap().is_none());
    assert!(
        !storage
            .repository_cache
            .watch_status(&storage, root)
            .unwrap()
            .healthy
    );
    let next = storage
        .repository_cache
        .lease(&storage, root, "again")
        .unwrap();
    assert_ne!(first.generation, next.generation);
    watcher_ready(&entry);
    storage.repository_cache.release_lease(root, "again");
}

#[test]
fn releasing_during_registration_does_not_resurrect_the_watcher() {
    let (_dir, storage, repo) = fixture();
    let root = Path::new(&repo.path);
    storage
        .repository_cache
        .lease(&storage, root, "short")
        .unwrap();
    let entry = storage.repository_cache.entry(&storage, root).unwrap();
    storage.repository_cache.release_lease(root, "short");
    let deadline = Instant::now() + Duration::from_secs(5);
    while Arc::strong_count(&entry.healthy) > 1 {
        assert!(
            Instant::now() < deadline,
            "abandoned registration did not finish"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(entry.watcher.lock().unwrap().is_none());
    assert!(!entry.status().healthy);
}

#[test]
fn first_atomic_save_is_content_only_but_delete_recreate_is_structural() {
    use notify::{
        Event, EventKind,
        event::{CreateKind, ModifyKind, RemoveKind, RenameMode},
    };
    let (_dir, storage, repo) = fixture();
    let root = Path::new(&repo.path);
    let (sender, receiver) = std::sync::mpsc::channel();
    storage.repository_cache.set_notifier(move |event| {
        let _ = sender.send(event);
    });
    let entry = storage.repository_cache.entry(&storage, root).unwrap();
    let mutation = EditorMutation::Save {
        path: "file-1.txt".into(),
        text: "first save".into(),
        expected_revision: crate::editor::read(root, "file-1.txt").unwrap().revision,
    };
    crate::editor::mutate(root, mutation.clone()).unwrap();
    // Pair-aware watchers report the temp->target rename. macOS can instead
    // report an unpaired rename; native save provenance resolves that case.
    for event in [
        Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
            .add_path(root.join(".reviewbox-save-fixture"))
            .add_path(root.join("file-1.txt")),
        Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Any)))
            .add_path(root.join("file-1.txt")),
    ] {
        (entry.publish)(events::classify(root, Ok(event)).unwrap());
    }
    storage
        .repository_cache
        .notify_editor_mutation(root, &mutation);
    let changed = receiver.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(changed.paths, ["file-1.txt"]);
    assert!(!changed.tree && !changed.full);
    fs::remove_file(root.join("file-1.txt")).unwrap();
    fs::write(root.join("file-1.txt"), "recreated bytes").unwrap();
    for kind in [
        EventKind::Remove(RemoveKind::File),
        EventKind::Create(CreateKind::File),
    ] {
        (entry.publish)(
            events::classify(root, Ok(Event::new(kind).add_path(root.join("file-1.txt")))).unwrap(),
        );
    }
    storage
        .repository_cache
        .notify_editor_mutation(root, &mutation);
    let recreated = receiver.recv_timeout(Duration::from_secs(3)).unwrap();
    assert!(recreated.tree && !recreated.full);
}
