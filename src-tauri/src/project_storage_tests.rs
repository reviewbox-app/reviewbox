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
fn legacy_migration_preserves_ids_private_state_and_original_database() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("repo");
    fs::create_dir(&root).unwrap();
    git(&root, &["init", "-q"]);
    fs::write(root.join("a.ts"), "legacy\n").unwrap();
    let s = Storage::open(dir.path().join("app")).unwrap();
    let path = root.canonicalize().unwrap().to_str().unwrap().to_string();
    let r = Repository {
        id: fingerprint(path.as_bytes()),
        path,
        name: "legacy".into(),
        branch: "main".into(),
        opened_at: now(),
    };
    s.insert("repository", &r.id, &r).unwrap();
    let w = capture(&s, &r);
    let mut review = w.review.clone();
    review.position.line = 12;
    s.replace("review", &review.id, 0, &review).unwrap();
    repositories::open(&s, &r.path).unwrap();
    assert_eq!(
        reviews::load(&s, &review.id).unwrap().review.position.line,
        12
    );
    assert!(
        root.join(format!(".reviewbox/reviews/{}/review.json", review.id))
            .exists()
    );
    assert_eq!(
        fs::read_dir(dir.path().join("app/backups"))
            .unwrap()
            .count(),
        1
    );
    assert!(s.local_get::<Review>("review", &review.id).is_ok());
    drop(s);
    let s = Storage::open(dir.path().join("app")).unwrap();
    repositories::open(&s, &r.path).unwrap();
    assert_eq!(s.list::<Review>("review").unwrap().len(), 1);
    assert_eq!(
        fs::read_dir(dir.path().join("app/backups"))
            .unwrap()
            .count(),
        1
    );
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
    let portable = read(&root.join(format!(".reviewbox/content/{hash}.json")));
    assert!(portable["gitOid"].is_null());
    assert!(portable["baseOid"].is_string());
}

#[test]
fn removing_shared_data_does_not_resurrect_retired_sqlite_rows() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("repo");
    fs::create_dir(&root).unwrap();
    git(&root, &["init", "-q"]);
    fs::write(root.join("a.ts"), "legacy").unwrap();
    let s = Storage::open(dir.path().join("app")).unwrap();
    let path = root.canonicalize().unwrap().to_string_lossy().into_owned();
    let r = Repository {
        id: fingerprint(path.as_bytes()),
        path,
        name: "fixture".into(),
        branch: "main".into(),
        opened_at: now(),
    };
    s.insert("repository", &r.id, &r).unwrap();
    let w = capture(&s, &r);
    repositories::open(&s, &r.path).unwrap();
    assert!(reviews::load(&s, &w.review.id).is_ok());
    drop(s);
    fs::remove_dir_all(root.join(".reviewbox")).unwrap();
    let s = Storage::open(dir.path().join("app")).unwrap();
    repositories::open(&s, &r.path).unwrap();
    assert!(s.list::<Review>("review").unwrap().is_empty());
}
