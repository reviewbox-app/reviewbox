use super::*;
use crate::{repositories, reviews};
use std::{path::Path, process::Command};

fn git(path: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args(args)
        .current_dir(path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
fn draft(storage: &Storage, repository: &Repository) -> Workspace {
    reviews::create(
        storage,
        CaptureRequest {
            repository_id: repository.id.clone(),
            scope: Scope::Local,
            base: None,
            target: None,
            include_untracked: true,
        },
    )
    .unwrap()
}
fn finish(storage: &Storage, workspace: &Workspace) -> Workspace {
    reviews::apply(
        storage,
        &workspace.review.id,
        workspace.review.revision,
        ReviewAction::CompleteManualReview,
    )
    .unwrap()
}
fn fixture() -> (tempfile::TempDir, Storage, Repository, Workspace) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("repo");
    fs::create_dir(&root).unwrap();
    git(&root, &["init", "-q"]);
    git(&root, &["config", "user.name", "Archive fixture"]);
    git(&root, &["config", "user.email", "archive@example.invalid"]);
    fs::write(root.join("code.ts"), "const value = 1;\n").unwrap();
    git(&root, &["add", "."]);
    git(
        &root,
        &["-c", "commit.gpgsign=false", "commit", "-qm", "Base"],
    );
    let storage = Storage::open(directory.path().join("app")).unwrap();
    let repository = repositories::open(&storage, root.to_str().unwrap()).unwrap();
    fs::write(root.join("code.ts"), "const value = 1.5;\n").unwrap();
    git(&root, &["add", "code.ts"]);
    fs::write(root.join("code.ts"), "const value = 2;\n").unwrap();
    let first = finish(&storage, &draft(&storage, &repository));
    assert_eq!(
        first.review.publication.status,
        PublicationStatus::Published
    );
    git(&root, &["add", "."]);
    git(
        &root,
        &[
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-qm",
            "First review",
        ],
    );
    (directory, storage, repository, first)
}
fn rotate(storage: &Storage, repository: &Repository) {
    fs::write(
        Path::new(&repository.path).join("code.ts"),
        "const value = 3;\n",
    )
    .unwrap();
    let second = finish(storage, &draft(storage, repository));
    assert_eq!(
        second.review.publication.status,
        PublicationStatus::Published,
        "{:?}",
        second.review.publication.publication_error
    );
}

#[test]
fn archive_reads_require_checkout_when_another_checkout_contains_same_review() {
    let (directory, storage, repository, first) = fixture();
    let clone = directory.path().join("clone");
    git(
        directory.path(),
        &["clone", "-q", &repository.path, clone.to_str().unwrap()],
    );
    rotate(&storage, &repository);
    let other = repositories::open(&storage, clone.to_str().unwrap()).unwrap();
    assert_eq!(
        reviews::load(&storage, &first.review.id).unwrap_err().code,
        "ambiguous_checkout"
    );
    let original = storage.scoped(Some(&repository.id));
    let copied = storage.scoped(Some(&other.id));
    let archived = reviews::load(&original, &first.review.id).unwrap();
    assert_eq!(
        archived.review.publication.status,
        PublicationStatus::Archived
    );
    assert_eq!(
        reviews::load(&copied, &first.review.id)
            .unwrap()
            .review
            .publication
            .status,
        PublicationStatus::Published
    );
    assert_eq!(
        storage
            .get::<Snapshot>("snapshot", &archived.snapshot.id)
            .unwrap_err()
            .code,
        "ambiguous_checkout"
    );
}

#[test]
fn archive_attestation_scope_and_identity_are_verified_before_reference_overlay() {
    let (_directory, storage, repository, first) = fixture();
    rotate(&storage, &repository);
    let path =
        Path::new(&repository.path).join(format!(".reviewbox/references/{}.json", first.review.id));
    let original: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let valid = reviews::load(&storage, &first.review.id).unwrap();
    assert_eq!(
        valid.review.publication.completion,
        first.review.publication.completion
    );
    let mut variants = Vec::new();
    let mut modified = original.clone();
    modified["data"]["publication"]["completion"]["author"] = json!("Different reviewer");
    variants.push(modified);
    let mut modified = original.clone();
    modified["data"]["publication"]["completion"]["scopeFingerprint"] = json!("0".repeat(64));
    variants.push(modified);
    let mut modified = original.clone();
    modified["data"]["scope"]["scope"] = json!("staged");
    variants.push(modified);
    let mut modified = original.clone();
    modified["data"]["title"] = json!("Different review");
    variants.push(modified);
    let mut modified = original.clone();
    modified["data"]["snapshotId"] = json!("different-snapshot");
    variants.push(modified);
    let mut modified = original.clone();
    modified["data"]["publication"]["fileCount"] = json!(999);
    variants.push(modified);
    for modified in variants {
        fs::write(&path, serde_json::to_vec_pretty(&modified).unwrap()).unwrap();
        storage.mount(&repository).unwrap();
        assert_eq!(
            reviews::load(&storage, &first.review.id).unwrap_err().code,
            "invalid_publication"
        );
    }
    fs::write(&path, serde_json::to_vec_pretty(&original).unwrap()).unwrap();
    storage.mount(&repository).unwrap();
    assert!(reviews::load(&storage, &first.review.id).is_ok());
}

#[test]
fn archive_cache_reuses_files_evicts_lru_and_reloads_exact_source_after_eviction() {
    let (directory, storage, repository, first) = fixture();
    let repo = Path::new(&repository.path);
    let second_draft = {
        fs::write(repo.join("code.ts"), "const value = 3;\n").unwrap();
        draft(&storage, &repository)
    };
    let second = finish(&storage, &second_draft);
    git(repo, &["add", "."]);
    git(
        repo,
        &[
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-qm",
            "Second review",
        ],
    );
    fs::write(repo.join("code.ts"), "const value = 4;\n").unwrap();
    finish(&storage, &draft(&storage, &repository));
    let first_reference: Value = storage.get("review_reference", &first.review.id).unwrap();
    let second_reference: Value = storage.get("review_reference", &second.review.id).unwrap();
    let project = storage.projects.lock().unwrap()[&repository.id]
        .project
        .clone();
    let first_path = project.root.join(format!(
        ".local/archives/{}/{}",
        first.review.id,
        first_reference["publication"]["archive"]["bundleHash"]
            .as_str()
            .unwrap()
    ));
    let second_path = project.root.join(format!(
        ".local/archives/{}/{}",
        second.review.id,
        second_reference["publication"]["archive"]["bundleHash"]
            .as_str()
            .unwrap()
    ));
    project
        .load_archive_with_limit(&first_reference, &Default::default(), 1)
        .unwrap();
    let metadata_path = first_path.join(format!("reviews/{}/review.json", first.review.id));
    let modified = fs::metadata(&metadata_path).unwrap().modified().unwrap();
    project
        .load_archive_with_limit(&first_reference, &Default::default(), 1)
        .unwrap();
    assert_eq!(
        fs::metadata(&metadata_path).unwrap().modified().unwrap(),
        modified
    );
    let reader = storage.pin_snapshot(&first.snapshot.id);
    let mut protected = storage
        .active_snapshots
        .lock()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    project
        .load_archive_with_limit(&second_reference, &protected, 1)
        .unwrap();
    assert!(first_path.exists(), "Pinned snapshot must survive pressure");
    assert!(
        second_path.exists(),
        "Current archive must survive pressure"
    );
    drop(reader);
    protected.clear();
    project
        .load_archive_with_limit(&second_reference, &protected, 1)
        .unwrap();
    assert!(
        !first_path.exists(),
        "Least recently used unpinned archive is evicted"
    );
    assert!(second_path.exists());
    let intermediate = first
        .snapshot
        .changes
        .iter()
        .find(|change| change.layer == "staged")
        .unwrap()
        .after
        .as_ref()
        .unwrap();
    let cached = directory.path().join("app/blobs").join(&intermediate.hash);
    if cached.exists() {
        fs::remove_file(cached).unwrap();
    }
    fs::write(repo.join("code.ts"), "unrelated live code\n").unwrap();
    assert_eq!(
        storage.read_blob(&intermediate.hash).unwrap(),
        b"const value = 1.5;\n"
    );
    assert!(
        first_path.exists(),
        "Missing cached archive was reloaded from its Git reference"
    );
}
