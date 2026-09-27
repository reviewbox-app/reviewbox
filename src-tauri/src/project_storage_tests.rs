use crate::{
    contracts::*, integrations, project_storage::Project, repositories, reviews, snapshots,
    storage::Storage,
};
use serde_json::{Value, json};
use std::{fs, path::Path, process::Command};
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
    let c = &w.snapshot.changes[0];
    let anchor = CodeAnchor {
        snapshot_id: w.snapshot.id.clone(),
        change_id: c.id.clone(),
        passage_id: c.passages[0].id.clone(),
    };
    w = reviews::apply(
        &s,
        &w.review.id,
        w.review.revision,
        ReviewAction::AddAnnotation {
            anchor: anchor.clone(),
            body: "Shared comment".into(),
            question: true,
        },
    )
    .unwrap();
    w = reviews::apply(
        &s,
        &w.review.id,
        w.review.revision,
        ReviewAction::Validate { anchor },
    )
    .unwrap();
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
    assert_eq!(loaded.review.annotations[0].body, "Shared comment");
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
            .annotations
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
    let path = Path::new(&r.path).join(format!(".reviewbox/reviews/{}/review.json", w.review.id));
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
fn external_agents_create_enrich_and_comment_but_cannot_validate() {
    let (_dir, s, r) = fixture();
    fs::write(Path::new(&r.path).join("a.ts"), "const answer = 4;\n").unwrap();
    let w: Workspace = serde_json::from_value(
        integrations::dispatch(&s, json!({"method":"create","repo":r.path})).unwrap(),
    )
    .unwrap();
    let c = &w.snapshot.changes[0];
    let anchor = json!({"snapshotId":w.snapshot.id,"changeId":c.id,"passageId":c.passages[0].id});
    integrations::dispatch(&s,json!({"method":"annotate","repo":r.path,"reviewId":w.review.id,"snapshotId":w.snapshot.id,"anchor":anchor,"body":"Agent question","question":true})).unwrap();
    integrations::dispatch(&s,json!({"method":"enrich","repo":r.path,"reviewId":w.review.id,"snapshotId":w.snapshot.id,"content":{"kind":"topics","topics":[{"id":"topic","title":"Answer","brief":"Review it","steps":[{"id":"step","title":"Read answer","explanation":"A constant","anchors":[anchor]}]}]}})).unwrap();
    let loaded = reviews::load(&s, &w.review.id).unwrap();
    assert_eq!(loaded.review.topics.len(), 1);
    assert_eq!(loaded.review.annotations[0].author, "agent:external");
    assert!(!loaded.review.annotations[0].resolved);
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
    let w = capture(&s, &r);
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
fn v1_is_rejected_without_creating_lock_or_recovering_journal() {
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().join(".reviewbox");
    fs::create_dir_all(&project).unwrap();
    let original = b"{\"format\":\"reviewbox\",\"version\":1,\"projectId\":\"old\"}";
    fs::write(project.join("project.json"), original).unwrap();
    let error = Project::open(dir.path(), "repo").err().unwrap();
    assert_eq!(error.code, "project_version");
    assert_eq!(fs::read(project.join("project.json")).unwrap(), original);
    assert_eq!(fs::read_dir(&project).unwrap().count(), 1);
}
#[test]
fn interrupted_transaction_recovers_and_refuses_foreign_changes() {
    let (_dir, s, r) = fixture();
    let w = capture(&s, &r);
    let project = Project::open(Path::new(&r.path), &r.id).unwrap();
    let relative = format!("reviews/{}/review.json", w.review.id);
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
    let c = &w.snapshot.changes[0];
    let anchor = CodeAnchor {
        snapshot_id: w.snapshot.id.clone(),
        change_id: c.id.clone(),
        passage_id: c.passages[0].id.clone(),
    };
    let w = reviews::apply(
        &s,
        &w.review.id,
        0,
        ReviewAction::AddAnnotation {
            anchor,
            body: "initial".into(),
            question: false,
        },
    )
    .unwrap();
    let note = &w.review.annotations[0];
    let path = Path::new(&r.path).join(format!(
        ".reviewbox/reviews/{}/annotations/{}.json",
        w.review.id, note.id
    ));
    let mut value = read(&path);
    value["data"]["body"] = json!("edited externally");
    write(&path, &value);
    s.mount(&r).unwrap();
    assert_eq!(
        reviews::load(&s, &w.review.id).unwrap().review.annotations[0].body,
        "edited externally"
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
    let path = Path::new(&r.path).join(format!(".reviewbox/reviews/{}/review.json", w.review.id));
    let outside = dir.path().join("outside.json");
    fs::rename(&path, &outside).unwrap();
    std::os::unix::fs::symlink(&outside, &path).unwrap();
    assert_eq!(s.mount(&r).unwrap_err().code, "external_path");
    assert!(outside.exists());
}

#[test]
fn two_clones_in_one_app_keep_their_documents_and_reading_state_separate() {
    let (dir, s, r) = fixture();
    let w = capture(&s, &r);
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
    reviews::apply(
        &second,
        &w.review.id,
        w2.review.revision,
        ReviewAction::Rename {
            title: "Only clone two".into(),
        },
    )
    .unwrap();
    assert_eq!(
        reviews::load(&first, &w.review.id).unwrap().review.title,
        w.review.title
    );
    assert_eq!(
        reviews::load(&second, &w.review.id).unwrap().review.title,
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
    let snapshot = read(&root.join(format!(".reviewbox/snapshots/{}.json", w.snapshot.id)));
    let source = &snapshot["data"]["sourceIndex"][hash];
    assert_eq!(source["kind"], "pack");
    let pack = read(
        &root
            .join(".reviewbox")
            .join(source["path"].as_str().unwrap()),
    );
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
        let snapshot = read(&root.join(format!(".reviewbox/snapshots/{}.json", w.snapshot.id)));
        assert_eq!(snapshot["version"], 2);
        let dir = root.join(format!(".reviewbox/content/{}", w.snapshot.id));
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        assert!(dir.join("0001.json").exists());
        let sources = snapshot["data"]["sourceIndex"].as_object().unwrap();
        assert_eq!(sources.values().filter(|v| v["kind"] == "pack").count(), 1);
    }
    assert_eq!(
        fs::read_dir(root.join(".reviewbox/content"))
            .unwrap()
            .count(),
        5
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
    let path = root.join(format!(".reviewbox/content/{}/0001.json", w.snapshot.id));
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
    let pack_path = format!("content/{}/0001.json", w.snapshot.id);
    let snapshot_path = format!("snapshots/{}.json", w.snapshot.id);
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
