use crate::{
    contracts::*, integrations, project_storage::Project, repositories, reviews, snapshots,
    storage::Storage,
};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
fn git(root: &Path, args: &[&str]) {
    let out = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}
fn fixture() -> (tempfile::TempDir, Storage, Repository) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("repo");
    fs::create_dir(&root).unwrap();
    git(&root, &["init", "-q"]);
    git(&root, &["config", "user.name", "Fixture"]);
    git(&root, &["config", "user.email", "test@example.invalid"]);
    fs::write(root.join("a.ts"), b"const answer = 1;\r\n").unwrap();
    fs::write(root.join("image.bin"), [0, 1, 2, 0, 5]).unwrap();
    git(&root, &["add", "."]);
    git(&root, &["commit", "-qm", "base"]);
    let storage = Storage::open(dir.path().join("app")).unwrap();
    let repo = repositories::open(&storage, root.to_str().unwrap()).unwrap();
    (dir, storage, repo)
}
fn capture(s: &Storage, r: &Repository) -> Workspace {
    reviews::create(
        s,
        CaptureRequest {
            repository_id: r.id.clone(),
            scope: Scope::Local,
            base: None,
            target: None,
            include_untracked: true,
        },
    )
    .unwrap()
}
fn draft_root(r: &Repository, w: &Workspace) -> PathBuf {
    Path::new(&r.path).join(format!(".reviewbox/.local/reviews/{}", w.review.id))
}
fn complete(s: &Storage, w: &Workspace) -> Workspace {
    reviews::apply(
        s,
        &w.review.id,
        w.review.revision,
        ReviewAction::CompleteManualReview,
    )
    .unwrap()
}
fn read(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}
fn write(path: &Path, v: &Value) {
    fs::write(path, serde_json::to_vec_pretty(v).unwrap()).unwrap();
}
fn copy_dir(src: &Path, dest: &Path) {
    fs::create_dir_all(dest).unwrap();
    for e in fs::read_dir(src).unwrap() {
        let e = e.unwrap();
        if e.file_name() == ".local" {
            continue;
        }
        if e.path().is_dir() {
            copy_dir(&e.path(), &dest.join(e.file_name()));
        } else {
            fs::copy(e.path(), dest.join(e.file_name())).unwrap();
        }
    }
}
#[test]
fn fresh_clone_rebuilds_all_layers_without_touching_git_or_sources() {
    let (dir, s, r) = fixture();
    let root = Path::new(&r.path);
    fs::write(root.join("a.ts"), b"const answer = 2;\r\n").unwrap();
    git(root, &["add", "a.ts"]);
    fs::write(root.join("a.ts"), b"const answer = 3;").unwrap();
    fs::write(root.join("image.bin"), [0, 1, 9, 0, 5, 8]).unwrap();
    fs::write(root.join("new.txt"), "new\n").unwrap();
    let mut w = capture(&s, &r);
    w = reviews::apply(
        &s,
        &w.review.id,
        w.review.revision,
        ReviewAction::ValidateFile {
            file_id: crate::reader::file_id("a.ts"),
        },
    )
    .unwrap();
    w = complete(&s, &w);
    let mut personal = w.review.clone();
    personal.position.line = 99;
    s.save_reading(&personal).unwrap();
    git(root, &["add", ".reviewbox"]);
    git(root, &["commit", "-qm", "share metadata and staged layer"]);
    let clone = dir.path().join("clone");
    git(
        dir.path(),
        &["clone", "-q", r.path.as_str(), clone.to_str().unwrap()],
    );
    let other = Storage::open(dir.path().join("other-app")).unwrap();
    let remote = repositories::open(&other, clone.to_str().unwrap()).unwrap();
    let loaded = reviews::load(&other, &w.review.id).unwrap();
    assert_ne!(remote.id, r.id);
    assert_eq!(loaded.review.repository_id, remote.id);
    assert_eq!(
        loaded.review.decisions[0].author,
        w.review.decisions[0].author
    );
    assert_eq!(loaded.review.position.line, 0);
    for file in &w.snapshot.files {
        assert_eq!(
            s.read_blob(&file.content.hash).unwrap(),
            other.read_blob(&file.content.hash).unwrap()
        );
    }
    for change in &w.snapshot.changes {
        for b in [&change.before, &change.after].into_iter().flatten() {
            assert_eq!(
                s.read_blob(&b.hash).unwrap(),
                other.read_blob(&b.hash).unwrap()
            );
        }
    }
    assert_eq!(
        repositories::text(&clone, &["status", "--porcelain"]).unwrap(),
        ""
    );
    assert_eq!(
        fs::read(clone.join("a.ts")).unwrap(),
        b"const answer = 2;\r\n"
    );
    // Removing the entire local index/cache cannot remove the shared project.
    drop(other);
    let rebuilt = Storage::open(dir.path().join("rebuilt-app")).unwrap();
    repositories::open(&rebuilt, clone.to_str().unwrap()).unwrap();
    assert_eq!(
        reviews::load(&rebuilt, &w.review.id)
            .unwrap()
            .review
            .decisions
            .len(),
        1
    );
}
#[test]
fn metadata_edits_and_metadata_only_commits_do_not_invalidate_code() {
    let (_dir, s, r) = fixture();
    let root = Path::new(&r.path);
    let w = capture(&s, &r);
    assert!(!snapshots::repository_changed(&s, &w.snapshot).unwrap());
    reviews::apply(
        &s,
        &w.review.id,
        0,
        ReviewAction::Rename {
            title: "Edited review".into(),
        },
    )
    .unwrap();
    assert!(!snapshots::repository_changed(&s, &w.snapshot).unwrap());
    git(root, &["add", ".reviewbox"]);
    git(root, &["commit", "-qm", "metadata only"]);
    assert!(!snapshots::repository_changed(&s, &w.snapshot).unwrap());
}
#[test]
fn external_edits_conflicts_invalid_files_and_branch_rollback_are_detected() {
    let (_dir, s, r) = fixture();
    let w = capture(&s, &r);
    let path = draft_root(&r, &w).join(format!("reviews/{}/review.json", w.review.id));
    let original = fs::read(&path).unwrap();
    let mut v = read(&path);
    v["data"]["title"] = json!("External title");
    write(&path, &v);
    s.mount(&r).unwrap();
    let current = reviews::load(&s, &w.review.id).unwrap();
    assert_eq!(current.review.title, "External title");
    assert!(current.review.revision > 0);
    assert!(
        reviews::apply(
            &s,
            &w.review.id,
            0,
            ReviewAction::Rename {
                title: "would overwrite".into()
            }
        )
        .is_err()
    );
    fs::write(&path, b"<<<<<<< conflict\n").unwrap();
    assert!(s.mount(&r).is_err());
    assert_eq!(fs::read(&path).unwrap(), b"<<<<<<< conflict\n");
    fs::write(&path, original).unwrap();
    s.mount(&r).unwrap();
    assert_eq!(
        reviews::load(&s, &w.review.id).unwrap().review.title,
        w.review.title
    );
}
#[test]
fn external_agents_create_but_cannot_annotate_or_validate() {
    let (_dir, s, r) = fixture();
    fs::write(Path::new(&r.path).join("a.ts"), "const answer = 4;\n").unwrap();
    let w: Workspace = serde_json::from_value(
        integrations::dispatch(&s, json!({"method":"create","repo":r.path})).unwrap(),
    )
    .unwrap();
    let c = &w.snapshot.changes[0];
    let anchor = json!({"snapshotId":w.snapshot.id,"changeId":c.id,"passageId":c.passages[0].id});
    assert!(integrations::dispatch(&s,json!({"method":"annotate","repo":r.path,"reviewId":w.review.id,"snapshotId":w.snapshot.id,"anchor":anchor,"body":"Agent question","question":true})).is_err());
    let loaded = reviews::load(&s, &w.review.id).unwrap();
    assert!(loaded.review.decisions.is_empty());
    assert!(
        integrations::dispatch(
            &s,
            json!({"method":"validate","repo":r.path,"snapshotId":w.snapshot.id,"anchor":anchor})
        )
        .is_err()
    );
}
#[test]
fn settings_and_reading_are_separate_and_missing_git_has_no_fallback() {
    let (dir, s, r) = fixture();
    fs::write(Path::new(&r.path).join("a.ts"), "changed for publication").unwrap();
    let w = complete(&s, &capture(&s, &r));
    let mut settings = s.project_settings(&r.id).unwrap();
    settings.language = "English".into();
    settings.provider = Some("claude".into());
    s.save_project_settings(&r.id, settings).unwrap();
    s.insert(
        "providers",
        "settings",
        &json!({"executable":"/personal/executable"}),
    )
    .unwrap();
    let root = Path::new(&r.path);
    let manifest = fs::read_to_string(root.join(".reviewbox/settings.json")).unwrap();
    assert!(manifest.contains("English"));
    assert!(!manifest.contains("/personal"));
    let empty = dir.path().join("no-history");
    fs::create_dir(&empty).unwrap();
    git(&empty, &["init", "-q"]);
    copy_dir(&root.join(".reviewbox"), &empty.join(".reviewbox"));
    fs::write(empty.join("a.ts"), "wrong current text").unwrap();
    let other = Storage::open(dir.path().join("empty-app")).unwrap();
    repositories::open(&other, empty.to_str().unwrap()).unwrap();
    let error = other
        .read_blob(&w.snapshot.files[0].content.hash)
        .unwrap_err();
    assert_eq!(error.code, "missing_git_object");
}
#[test]
fn legacy_rows_are_never_read_or_imported() {
    let (dir, s, r) = fixture();
    let w = capture(&s, &r);
    let db = rusqlite::Connection::open(dir.path().join("app/reviewbox.sqlite3")).unwrap();
    db.execute(
        "INSERT INTO documents(kind,id,revision,body) VALUES('review',?1,0,?2)",
        rusqlite::params![w.review.id, serde_json::to_string(&w.review).unwrap()],
    )
    .unwrap();
    drop(db);
    drop(s);
    fs::remove_dir_all(Path::new(&r.path).join(".reviewbox")).unwrap();
    let s = Storage::open(dir.path().join("app")).unwrap();
    assert!(s.get::<Review>("review", &w.review.id).is_err());
    assert!(s.list::<Review>("review").unwrap().is_empty());
    repositories::open(&s, &r.path).unwrap();
    assert!(s.list::<Review>("review").unwrap().is_empty());
    assert!(s.local_get::<Review>("review", &w.review.id).is_ok());
    assert!(!dir.path().join("app/backups").exists());
}
#[test]
fn older_formats_are_rejected_without_creating_lock_or_recovering_journal() {
    for version in [1, 2, 3] {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join(".reviewbox");
        fs::create_dir_all(&project).unwrap();
        let original = serde_json::to_vec(
            &json!({"format":"reviewbox", "version":version, "projectId":"old"}),
        )
        .unwrap();
        fs::write(project.join("project.json"), &original).unwrap();
        let error = Project::open(dir.path(), "repo").err().unwrap();
        assert_eq!(error.code, "project_version");
        assert_eq!(fs::read(project.join("project.json")).unwrap(), original);
        assert_eq!(fs::read_dir(&project).unwrap().count(), 1);
    }
}
#[test]
fn interrupted_transaction_recovers_and_refuses_foreign_changes() {
    let (_dir, s, r) = fixture();
    let w = capture(&s, &r);
    let project = Project::open(Path::new(&r.path), &r.id).unwrap();
    let relative = format!(
        ".local/reviews/{}/reviews/{}/review.json",
        w.review.id, w.review.id
    );
    let path = project.root.join(&relative);
    let old = fs::read(&path).unwrap();
    let mut next = read(&path);
    next["data"]["title"] = json!("Recovered");
    let after = serde_json::to_string_pretty(&next).unwrap();
    let journal = project.root.join(".local/transaction.json");
    write(
        &journal,
        &json!([{"path":relative,"before":fingerprint(&old),"after":after}]),
    );
    s.mount(&r).unwrap();
    assert!(!journal.exists());
    assert_eq!(
        reviews::load(&s, &w.review.id).unwrap().review.title,
        "Recovered"
    );
    write(
        &journal,
        &json!([{"path":relative,"before":fingerprint(&old),"after":"{}"}]),
    );
    assert!(s.mount(&r).is_err());
    assert!(journal.exists());
    assert_eq!(read(&path)["data"]["title"], "Recovered");
}

#[test]
fn concurrent_clients_cannot_overwrite_a_newer_review() {
    let (dir, s, r) = fixture();
    let w = capture(&s, &r);
    let other = Storage::open(dir.path().join("second-app")).unwrap();
    repositories::open(&other, &r.path).unwrap();
    let old = reviews::load(&other, &w.review.id).unwrap();
    reviews::apply(
        &s,
        &w.review.id,
        0,
        ReviewAction::Rename {
            title: "First writer".into(),
        },
    )
    .unwrap();
    let error = reviews::apply(
        &other,
        &w.review.id,
        old.review.revision,
        ReviewAction::Rename {
            title: "Lost update".into(),
        },
    )
    .unwrap_err();
    assert_eq!(error.code, "conflict");
    s.mount(&r).unwrap();
    assert_eq!(
        reviews::load(&s, &w.review.id).unwrap().review.title,
        "First writer"
    );
}
#[test]
fn edited_child_without_revision_bump_invalidates_stale_writes() {
    let (_dir, s, r) = fixture();
    fs::write(Path::new(&r.path).join("a.ts"), "changed").unwrap();
    let w = capture(&s, &r);
    let w = reviews::apply(
        &s,
        &w.review.id,
        0,
        ReviewAction::ValidateFile {
            file_id: crate::reader::file_id("a.ts"),
        },
    )
    .unwrap();
    let decision = &w.review.decisions[0];
    let path = draft_root(&r, &w).join(format!(
        "reviews/{}/decisions/{}.json",
        w.review.id, decision.id
    ));
    let mut value = read(&path);
    value["data"]["author"] = json!("human:external");
    write(&path, &value);
    s.mount(&r).unwrap();
    assert_eq!(
        reviews::load(&s, &w.review.id).unwrap().review.decisions[0].author,
        "human:external"
    );
    assert!(
        reviews::apply(
            &s,
            &w.review.id,
            w.review.revision,
            ReviewAction::Rename {
                title: "stale".into()
            }
        )
        .is_err()
    );
}
#[cfg(unix)]
#[test]
fn symlinked_project_documents_are_rejected() {
    let (dir, s, r) = fixture();
    let w = capture(&s, &r);
    let path = draft_root(&r, &w).join(format!("reviews/{}/review.json", w.review.id));
    let outside = dir.path().join("outside.json");
    fs::rename(&path, &outside).unwrap();
    std::os::unix::fs::symlink(&outside, &path).unwrap();
    assert_eq!(s.mount(&r).unwrap_err().code, "external_path");
    assert!(outside.exists());
}

#[test]
fn two_clones_in_one_app_keep_their_documents_and_reading_state_separate() {
    let (dir, s, r) = fixture();
    fs::write(Path::new(&r.path).join("a.ts"), "a captured change").unwrap();
    let w = complete(&s, &capture(&s, &r));
    let root = Path::new(&r.path);
    git(root, &["add", ".reviewbox"]);
    git(root, &["commit", "-qm", "share"]);
    let clone = dir.path().join("clone");
    git(
        dir.path(),
        &["clone", "-q", &r.path, clone.to_str().unwrap()],
    );
    let other = repositories::open(&s, clone.to_str().unwrap()).unwrap();
    let first = s.scoped(Some(&r.id));
    let second = s.scoped(Some(&other.id));
    let w2 = reviews::load(&second, &w.review.id).unwrap();
    assert_eq!(w2.review.repository_id, other.id);
    let fork = reviews::apply(
        &second,
        &w.review.id,
        w2.review.revision,
        ReviewAction::ReopenReview,
    )
    .unwrap();
    assert_ne!(fork.review.id, w.review.id);
    reviews::apply(
        &second,
        &fork.review.id,
        fork.review.revision,
        ReviewAction::Rename {
            title: "Only clone two".into(),
        },
    )
    .unwrap();
    assert!(reviews::load(&first, &fork.review.id).is_err());
    assert_eq!(
        reviews::load(&first, &w.review.id).unwrap().review.title,
        w.review.title
    );
    assert_eq!(
        reviews::load(&second, &fork.review.id)
            .unwrap()
            .review
            .title,
        "Only clone two"
    );
    let mut local = reviews::load(&first, &w.review.id).unwrap().review;
    local.position.line = 32;
    first.save_reading(&local).unwrap();
    assert_eq!(
        reviews::load(&second, &w.review.id)
            .unwrap()
            .review
            .position
            .line,
        0
    );
}

#[test]
fn uncommitted_content_never_references_an_unrelated_repository_commit() {
    let (_first, s, r) = fixture();
    let (_second, other_store, other) = fixture();
    drop(other_store);
    let other_root = Path::new(&other.path);
    fs::write(other_root.join("a.ts"), "unpublished shared bytes").unwrap();
    git(other_root, &["add", "a.ts"]);
    git(other_root, &["commit", "-qm", "other history"]);
    repositories::open(&s, &other.path).unwrap();
    capture(&s.scoped(Some(&other.id)), &other);
    let root = Path::new(&r.path);
    fs::write(root.join("a.ts"), "unpublished shared bytes").unwrap();
    git(root, &["add", "a.ts"]);
    git(root, &["reset", "-q", "HEAD", "--", "a.ts"]);
    let w = capture(&s.scoped(Some(&r.id)), &r);
    let hash = &w
        .snapshot
        .files
        .iter()
        .find(|f| f.path == "a.ts")
        .unwrap()
        .content
        .hash;
    let snapshot = read(&draft_root(&r, &w).join(format!("snapshots/{}.json", w.snapshot.id)));
    let source = &snapshot["data"]["sourceIndex"][hash];
    assert_eq!(source["kind"], "pack");
    let pack = read(&draft_root(&r, &w).join(source["path"].as_str().unwrap()));
    assert!(pack["entries"][hash]["baseOid"].is_string());
}

#[test]
fn background_refresh_and_writes_share_the_same_lock_order() {
    let (_dir, s, r) = fixture();
    let w = capture(&s, &r);
    std::thread::scope(|scope| {
        let reader = scope.spawn(|| {
            for _ in 0..150 {
                reviews::load(&s, &w.review.id).unwrap();
                std::thread::yield_now();
            }
        });
        for n in 0..30 {
            let current = reviews::load(&s, &w.review.id).unwrap();
            reviews::apply(
                &s,
                &w.review.id,
                current.review.revision,
                ReviewAction::Rename {
                    title: format!("Concurrent read {n}"),
                },
            )
            .unwrap();
        }
        reader.join().unwrap();
    });
    assert_eq!(
        reviews::load(&s, &w.review.id).unwrap().review.title,
        "Concurrent read 29"
    );
}

#[test]
fn five_captures_of_235_files_write_five_packs_not_per_blob_files() {
    let (_dir, s, r) = fixture();
    let root = Path::new(&r.path);
    for n in 0..233 {
        fs::write(root.join(format!("file-{n}.txt")), format!("file {n}\n")).unwrap();
    }
    git(root, &["add", "."]);
    git(root, &["commit", "-qm", "235 project files"]);
    let committed = capture(&s, &r);
    assert_eq!(committed.snapshot.files.len(), 235);
    assert!(!root.join(".reviewbox/content").exists());
    for n in 0..5 {
        fs::write(root.join("a.ts"), format!("change {n}\r\n")).unwrap();
        let w = capture(&s, &r);
        let snapshot = read(&draft_root(&r, &w).join(format!("snapshots/{}.json", w.snapshot.id)));
        assert_eq!(snapshot["version"], 4);
        let dir = draft_root(&r, &w).join(format!("content/{}", w.snapshot.id));
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        assert!(dir.join("0001.json").exists());
        let sources = snapshot["data"]["sourceIndex"].as_object().unwrap();
        assert_eq!(sources.values().filter(|v| v["kind"] == "pack").count(), 1);
    }
    let drafts = root.join(".reviewbox/.local/reviews");
    assert_eq!(
        fs::read_dir(drafts)
            .unwrap()
            .filter(|entry| entry.as_ref().unwrap().path().join("content").exists())
            .count(),
        5
    );
    assert!(!root.join(".reviewbox/published").exists());
    assert_eq!(
        repositories::text(root, &["status", "--porcelain", "--", ".reviewbox/.local"]).unwrap(),
        ""
    );
}

#[test]
fn missing_corrupt_and_foreign_packs_never_use_the_working_tree() {
    let (dir, s, r) = fixture();
    let root = Path::new(&r.path);
    fs::write(root.join("a.ts"), "captured source").unwrap();
    let w = capture(&s, &r);
    let blob = &w
        .snapshot
        .files
        .iter()
        .find(|f| f.path == "a.ts")
        .unwrap()
        .content;
    let path = draft_root(&r, &w).join(format!("content/{}/0001.json", w.snapshot.id));
    let original = fs::read(&path).unwrap();
    fs::write(root.join("a.ts"), "wrong current source").unwrap();
    let error = |name: &str| {
        let fresh = Storage::open(dir.path().join(name)).unwrap();
        repositories::open(&fresh, &r.path).unwrap();
        fresh.read_blob(&blob.hash).unwrap_err()
    };
    fs::remove_file(&path).unwrap();
    assert_eq!(error("missing").code, "missing_content");
    fs::write(&path, &original).unwrap();
    let mut pack = read(&path);
    pack["entries"][&blob.hash]["text"] = json!("corrupted");
    write(&path, &pack);
    assert_eq!(error("corrupt").code, "corrupt_content");
    fs::write(&path, &original).unwrap();
    let mut pack = read(&path);
    pack["snapshotId"] = json!("foreign");
    write(&path, &pack);
    assert_eq!(error("foreign").code, "invalid_content");
    fs::write(&path, &original).unwrap();
    let fresh = Storage::open(dir.path().join("restored")).unwrap();
    repositories::open(&fresh, &r.path).unwrap();
    assert_eq!(fresh.read_blob(&blob.hash).unwrap(), b"captured source");
}

#[test]
fn interrupted_pack_publication_recovers_and_checks_all_targets_first() {
    let (_dir, s, r) = fixture();
    let root = Path::new(&r.path);
    fs::write(root.join("a.ts"), "pending capture").unwrap();
    let w = capture(&s, &r);
    let project = Project::open(root, &r.id).unwrap();
    let pack_path = format!(
        ".local/reviews/{}/content/{}/0001.json",
        w.review.id, w.snapshot.id
    );
    let snapshot_path = format!(
        ".local/reviews/{}/snapshots/{}.json",
        w.review.id, w.snapshot.id
    );
    let pack = fs::read_to_string(project.root.join(&pack_path)).unwrap();
    let snapshot = fs::read_to_string(project.root.join(&snapshot_path)).unwrap();
    let journal = project.root.join(".local/transaction.json");
    let changes = json!([
        {"path":pack_path,"before":null,"after":pack},
        {"path":snapshot_path,"before":null,"after":snapshot}
    ]);
    fs::remove_file(project.root.join(&snapshot_path)).unwrap();
    write(&journal, &changes);
    s.mount(&r).unwrap();
    assert!(project.root.join(&snapshot_path).exists());
    assert!(!journal.exists());
    fs::remove_file(project.root.join(&snapshot_path)).unwrap();
    fs::write(project.root.join(&pack_path), "external edit").unwrap();
    write(&journal, &changes);
    assert_eq!(s.mount(&r).unwrap_err().code, "project_conflict");
    assert!(journal.exists());
    assert!(!project.root.join(&snapshot_path).exists());
    assert_eq!(
        fs::read_to_string(project.root.join(&pack_path)).unwrap(),
        "external edit"
    );
}

#[test]
fn deleted_and_renamed_files_reconstruct_with_no_local_cache() {
    let (dir, s, r) = fixture();
    let root = Path::new(&r.path);
    git(root, &["mv", "a.ts", "renamed.ts"]);
    fs::remove_file(root.join("image.bin")).unwrap();
    let w = capture(&s, &r);
    let fresh = Storage::open(dir.path().join("fresh")).unwrap();
    repositories::open(&fresh, &r.path).unwrap();
    for c in &w.snapshot.changes {
        for b in [&c.before, &c.after].into_iter().flatten() {
            assert_eq!(
                s.read_blob(&b.hash).unwrap(),
                fresh.read_blob(&b.hash).unwrap()
            );
        }
    }
    assert!(!root.join(".reviewbox/content").exists());
}

fn json_files(root: &Path) -> std::collections::BTreeMap<String, String> {
    fn visit(
        root: &Path,
        directory: &Path,
        files: &mut std::collections::BTreeMap<String, String>,
    ) {
        if !directory.exists() {
            return;
        }
        for entry in fs::read_dir(directory).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                visit(root, &path, files);
            } else if path
                .extension()
                .is_some_and(|extension| extension == "json")
            {
                files.insert(
                    path.strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                    fs::read_to_string(path).unwrap(),
                );
            }
        }
    }
    let mut files = std::collections::BTreeMap::new();
    visit(root, root, &mut files);
    files
}

#[test]
fn interrupted_draft_promotion_recovers_all_files_before_releasing_local_content() {
    let (_dir, storage, repository) = fixture();
    let repo = Path::new(&repository.path);
    fs::write(repo.join("a.ts"), "reviewed but uncommitted code\n").unwrap();
    let draft = capture(&storage, &repository);
    let root = repo.join(".reviewbox");
    let before = json_files(&root);
    let published = complete(&storage, &draft);
    assert_eq!(
        published.review.publication.status,
        PublicationStatus::Published
    );
    let after = json_files(&root);
    let paths: std::collections::BTreeSet<_> = before.keys().chain(after.keys()).cloned().collect();
    let journal: Vec<_> = paths.iter().filter(|path| before.get(*path) != after.get(*path)).map(|path| {
        json!({"path":path,"before":before.get(path).map(|value|fingerprint(value.as_bytes())),"after":after.get(path)})
    }).collect();
    assert!(journal.iter().any(|patch| {
        patch["path"]
            .as_str()
            .unwrap()
            .starts_with(".local/reviews/")
            && patch["after"].is_null()
    }));
    assert!(
        journal
            .iter()
            .any(|patch| patch["path"].as_str().unwrap().starts_with("published/"))
    );
    let restore = || {
        for path in &paths {
            let target = root.join(path);
            if let Some(content) = before.get(path) {
                fs::create_dir_all(target.parent().unwrap()).unwrap();
                fs::write(target, content).unwrap();
            } else if target.exists() {
                fs::remove_file(target).unwrap();
            }
        }
    };
    restore();
    // Crash after one destination file was installed, while local source files remain.
    let first_destination = journal
        .iter()
        .find(|patch| patch["path"].as_str().unwrap().starts_with("published/"))
        .unwrap();
    let target = root.join(first_destination["path"].as_str().unwrap());
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    fs::write(&target, first_destination["after"].as_str().unwrap()).unwrap();
    write(&root.join(".local/transaction.json"), &json!(journal));
    storage.mount(&repository).unwrap();
    assert_eq!(json_files(&root), after);
    assert_eq!(
        reviews::load(&storage, &draft.review.id)
            .unwrap()
            .review
            .publication
            .status,
        PublicationStatus::Published
    );

    // A foreign edit is detected before any destination or deletion is replayed.
    restore();
    let local_review =
        draft_root(&repository, &draft).join(format!("reviews/{}/review.json", draft.review.id));
    let mut changed = read(&local_review);
    changed["data"]["title"] = json!("Another writer");
    write(&local_review, &changed);
    write(&root.join(".local/transaction.json"), &json!(journal));
    assert_eq!(
        storage.mount(&repository).unwrap_err().code,
        "project_conflict"
    );
    assert!(!target.exists());
    assert_eq!(read(&local_review)["data"]["title"], "Another writer");
    assert!(root.join(".local/transaction.json").exists());
}

#[test]
fn code_explain_keeps_its_capture_when_the_review_draft_is_refreshed_and_removed() {
    let (directory, storage, repository) = fixture();
    let repo = Path::new(&repository.path);
    fs::write(repo.join("a.ts"), "const captured = 7;\n").unwrap();
    let draft = capture(&storage, &repository);
    let source = draft
        .snapshot
        .files
        .iter()
        .find(|file| file.path == "a.ts")
        .unwrap();
    let mut knowledge = crate::knowledge::load(&storage, &repository.id).unwrap();
    knowledge.documents.push(ExplanationDocument {
        id: "independent-explanation".into(),
        repository_id: repository.id.clone(),
        snapshot_id: draft.snapshot.id.clone(),
        path: "a.ts".into(),
        fingerprint: source.content.hash.clone(),
        language: knowledge.language.clone(),
        sections: vec![ExplanationSection {
            id: "section".into(),
            title: "Captured value".into(),
            body: "The value is fixed at seven.".into(),
            start_line: 1,
            end_line: 1,
        }],
        occurrences: vec![],
        created_at: now(),
    });
    crate::knowledge::save(&storage, knowledge).unwrap();
    fs::write(repo.join("a.ts"), "const current = 99;\n").unwrap();
    let refreshed = reviews::refresh(&storage, &draft.review.id, draft.review.revision).unwrap();
    assert_ne!(refreshed.snapshot.id, draft.snapshot.id);
    storage.remove("review", &refreshed.review.id).unwrap();
    storage.collect_review_garbage(&repository.id).unwrap();
    assert!(
        storage
            .get::<Snapshot>("snapshot", &refreshed.snapshot.id)
            .is_err()
    );
    assert!(
        repo.join(format!(".reviewbox/snapshots/{}.json", draft.snapshot.id))
            .exists()
    );
    drop(storage);

    // Only shared Code Explain files travel; local review folders and caches do not.
    git(repo, &["add", ".reviewbox"]);
    git(repo, &["commit", "-qm", "Share independent explanation"]);
    let clone = directory.path().join("knowledge-clone");
    git(
        directory.path(),
        &["clone", "-q", &repository.path, clone.to_str().unwrap()],
    );
    let fresh = Storage::open(directory.path().join("knowledge-app")).unwrap();
    let other = repositories::open(&fresh, clone.to_str().unwrap()).unwrap();
    let loaded = crate::knowledge::load(&fresh, &other.id).unwrap();
    assert_eq!(
        loaded.documents[0].sections[0].body,
        "The value is fixed at seven."
    );
    assert_eq!(loaded.documents[0].snapshot_id, draft.snapshot.id);
    assert_eq!(
        fresh.read_blob(&source.content.hash).unwrap(),
        b"const captured = 7;\n"
    );
    assert!(fresh.list::<Review>("review").unwrap().is_empty());
    assert_eq!(
        fs::read(clone.join("a.ts")).unwrap(),
        b"const answer = 1;\r\n"
    );
}
