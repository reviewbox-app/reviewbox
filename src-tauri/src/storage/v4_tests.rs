use super::*;
use crate::{project_storage::Project, repositories, reviews};
use std::path::Path;

fn git(root: &Path, args: &[&str]) -> String {
    repositories::text(root, args).unwrap()
}

fn fixture() -> (tempfile::TempDir, Storage, Repository) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("repo");
    fs::create_dir(&root).unwrap();
    git(&root, &["init", "-b", "main"]);
    git(&root, &["config", "user.name", "V4 fixture"]);
    git(&root, &["config", "user.email", "v4@example.invalid"]);
    git(&root, &["config", "commit.gpgsign", "false"]);
    fs::write(root.join("a.ts"), b"const answer = 1;\r\n").unwrap();
    fs::write(root.join("image.bin"), [0, 1, 2, 0, 5]).unwrap();
    git(&root, &["add", "."]);
    git(&root, &["commit", "-m", "base code"]);
    let storage = Storage::open(dir.path().join("app")).unwrap();
    let repo = repositories::open(&storage, root.to_str().unwrap()).unwrap();
    git(&root, &["add", ".reviewbox"]);
    git(
        &root,
        &["commit", "-m", "initialize shared review settings"],
    );
    (dir, storage, repo)
}

fn capture(storage: &Storage, repo: &Repository) -> Workspace {
    reviews::create(
        storage,
        CaptureRequest {
            repository_id: repo.id.clone(),
            scope: Scope::Local,
            base: None,
            target: None,
            include_untracked: true,
        },
    )
    .unwrap()
}

fn complete(storage: &Storage, workspace: &Workspace) -> Workspace {
    let result = reviews::apply(
        storage,
        &workspace.review.id,
        workspace.review.revision,
        ReviewAction::CompleteManualReview,
    )
    .unwrap();
    assert_eq!(
        result.review.publication.status,
        PublicationStatus::Published,
        "{:?}",
        result.review.publication.publication_error
    );
    result
}

fn snapshot_bytes(storage: &Storage, snapshot: &Snapshot) -> BTreeMap<String, Vec<u8>> {
    snapshot
        .files
        .iter()
        .map(|file| {
            (
                file.content.hash.clone(),
                storage.read_blob(&file.content.hash).unwrap(),
            )
        })
        .chain(
            snapshot
                .changes
                .iter()
                .flat_map(|change| [&change.before, &change.after].into_iter().flatten())
                .map(|blob| (blob.hash.clone(), storage.read_blob(&blob.hash).unwrap())),
        )
        .collect()
}

fn clear_source_cache(storage: &Storage) {
    fs::remove_dir_all(storage.root().join("blobs")).unwrap();
    fs::create_dir(storage.root().join("blobs")).unwrap();
}

#[test]
fn drafts_and_repeated_refreshes_leave_no_review_diff_and_release_old_captures() {
    let (_dir, storage, repo) = fixture();
    let root = Path::new(&repo.path);
    fs::write(root.join("a.ts"), "const answer = 2;\n").unwrap();
    let mut workspace = capture(&storage, &repo);
    let review_id = workspace.review.id.clone();
    for number in 3..7 {
        let old_snapshot = workspace.snapshot.id.clone();
        fs::write(root.join("a.ts"), format!("const answer = {number};\n")).unwrap();
        workspace = reviews::refresh(&storage, &review_id, workspace.review.revision).unwrap();
        assert!(workspace.review.previous_snapshot_ids.is_empty());
        assert!(storage.get::<Snapshot>("snapshot", &old_snapshot).is_err());
        assert!(
            !root
                .join(format!(
                    ".reviewbox/.local/reviews/{review_id}/snapshots/{old_snapshot}.json"
                ))
                .exists()
        );
        assert_eq!(
            git(
                root,
                &[
                    "status",
                    "--porcelain",
                    "--untracked-files=all",
                    "--",
                    ".reviewbox"
                ]
            ),
            ""
        );
    }
    let snapshots: Vec<Snapshot> = storage.list("snapshot").unwrap();
    assert_eq!(snapshots.len(), 1);
    clear_source_cache(&storage);
    assert!(
        snapshot_bytes(&storage, &workspace.snapshot)
            .values()
            .any(|bytes| bytes == b"const answer = 6;\n")
    );
}

#[test]
fn publication_rotates_after_eight_commits_and_archives_reopen_in_clean_clone() {
    let (dir, storage, repo) = fixture();
    let root = Path::new(&repo.path);
    fs::write(root.join("a.ts"), b"const answer = 2;\r\n").unwrap();
    git(root, &["add", "a.ts"]);
    fs::write(root.join("a.ts"), b"const answer = 3;").unwrap();
    fs::write(root.join("image.bin"), [0, 9, 255, 0, 8, 7]).unwrap();
    fs::write(root.join("new.txt"), "new\n").unwrap();
    let first = complete(&storage, &capture(&storage, &repo));
    let captured = snapshot_bytes(&storage, &first.snapshot);
    git(root, &["add", "."]);
    git(root, &["commit", "-m", "A: reviewed code and publication"]);
    let first_commit = git(root, &["rev-parse", "HEAD"]);
    for index in 0..8 {
        fs::write(root.join("later.txt"), format!("later {index}\n")).unwrap();
        git(root, &["add", "later.txt"]);
        git(root, &["commit", "-m", &format!("subsequent {index}")]);
    }
    fs::write(root.join("a.ts"), "const answer = 4;\n").unwrap();
    let second = complete(&storage, &capture(&storage, &repo));
    let reference: Value = storage.get("review_reference", &first.review.id).unwrap();
    assert_eq!(
        reference["publication"]["archive"]["commitId"],
        first_commit
    );
    assert_eq!(
        reference["publication"]["matchingCommitIds"],
        json!([first_commit])
    );
    assert!(reference.get("topics").is_none());
    assert!(reference.get("decisions").is_none());
    assert!(
        !root
            .join(format!(
                ".reviewbox/published/{}/reviews/{}/review.json",
                first.review.id, first.review.id
            ))
            .exists()
    );
    assert!(
        root.join(format!(
            ".reviewbox/published/{}/bundle.json",
            second.review.id
        ))
        .exists()
    );
    git(root, &["add", "-A"]);
    git(root, &["commit", "-m", "B: publication and A reference"]);
    git(
        dir.path(),
        &["clone", "--no-hardlinks", &repo.path, "clone"],
    );
    let clone_root = dir.path().join("clone");
    let clone_storage = Storage::open(dir.path().join("clone-app")).unwrap();
    repositories::open(&clone_storage, clone_root.to_str().unwrap()).unwrap();
    fs::write(
        clone_root.join("a.ts"),
        "live code is unrelated to the archived source",
    )
    .unwrap();
    let index_before = fs::read(clone_root.join(".git/index")).unwrap();
    let archived = reviews::load(&clone_storage, &first.review.id).unwrap();
    assert_eq!(
        archived.review.publication.status,
        PublicationStatus::Archived
    );
    assert_eq!(snapshot_bytes(&clone_storage, &archived.snapshot), captured);
    clear_source_cache(&clone_storage);
    // Reloading and indexing the project while an archive is open must retain
    // the archive's exact source origin, even with an empty source cache.
    clone_storage.sync_projects(true).unwrap();
    let archived = reviews::load(&clone_storage, &first.review.id).unwrap();
    assert_eq!(snapshot_bytes(&clone_storage, &archived.snapshot), captured);
    assert_eq!(
        fs::read(clone_root.join(".git/index")).unwrap(),
        index_before
    );
    assert_eq!(
        git(&clone_root, &["status", "--porcelain", "--", ".reviewbox"]),
        ""
    );
}

#[test]
fn publication_embeds_sources_outside_head_history_before_their_git_objects_disappear() {
    let (_dir, storage, repo) = fixture();
    let root = Path::new(&repo.path);
    git(root, &["checkout", "-b", "temporary-source"]);
    fs::write(root.join("a.ts"), b"historical code only\r\n").unwrap();
    git(root, &["add", "a.ts"]);
    git(root, &["commit", "-m", "source on independent branch"]);
    let source_commit = git(root, &["rev-parse", "HEAD"]);
    let source_blob = git(root, &["rev-parse", "HEAD:a.ts"]);
    git(root, &["checkout", "main"]);
    let workspace = reviews::create(
        &storage,
        CaptureRequest {
            repository_id: repo.id.clone(),
            scope: Scope::Commit,
            base: None,
            target: Some(source_commit),
            include_untracked: true,
        },
    )
    .unwrap();
    let workspace = complete(&storage, &workspace);
    git(root, &["add", ".reviewbox"]);
    git(
        root,
        &[
            "commit",
            "-m",
            "publication retains captured source independently",
        ],
    );
    let object = root
        .join(".git/objects")
        .join(&source_blob[..2])
        .join(&source_blob[2..]);
    fs::remove_file(object).unwrap();
    clear_source_cache(&storage);
    let restored = reviews::load(&storage, &workspace.review.id).unwrap();
    let source = restored
        .snapshot
        .files
        .iter()
        .find(|file| file.path == "a.ts")
        .unwrap();
    assert_eq!(
        storage.read_blob(&source.content.hash).unwrap(),
        b"historical code only\r\n"
    );
}

#[test]
fn code_explain_promotes_referenced_snapshot_to_shared_storage_across_refresh() {
    let (_dir, storage, repo) = fixture();
    let root = Path::new(&repo.path);
    fs::write(root.join("a.ts"), "explain this source\n").unwrap();
    let workspace = capture(&storage, &repo);
    let source = workspace
        .snapshot
        .files
        .iter()
        .find(|file| file.path == "a.ts")
        .unwrap()
        .content
        .clone();
    let knowledge = ProjectKnowledge {
        repository_id: repo.id.clone(),
        language: "English".into(),
        terms: Vec::new(),
        revision: 0,
        documents: vec![ExplanationDocument {
            id: "explanation".into(),
            repository_id: repo.id.clone(),
            snapshot_id: workspace.snapshot.id.clone(),
            path: "a.ts".into(),
            fingerprint: source.hash.clone(),
            language: "English".into(),
            sections: Vec::new(),
            occurrences: Vec::new(),
            created_at: now(),
        }],
    };
    storage.insert("knowledge", &repo.id, &knowledge).unwrap();
    assert!(
        root.join(format!(
            ".reviewbox/snapshots/{}.json",
            workspace.snapshot.id
        ))
        .exists()
    );
    fs::write(root.join("a.ts"), "next source\n").unwrap();
    reviews::refresh(&storage, &workspace.review.id, workspace.review.revision).unwrap();
    clear_source_cache(&storage);
    let preserved: Snapshot = storage.get("snapshot", &workspace.snapshot.id).unwrap();
    assert_eq!(preserved.id, workspace.snapshot.id);
    assert_eq!(
        storage.read_blob(&source.hash).unwrap(),
        b"explain this source\n"
    );
    assert!(
        root.join(format!(
            ".reviewbox/snapshots/{}.json",
            workspace.snapshot.id
        ))
        .exists()
    );
    let knowledge: ProjectKnowledge = storage.get("knowledge", &repo.id).unwrap();
    assert_eq!(knowledge.documents[0].snapshot_id, preserved.id);
}

#[test]
fn version_three_project_is_rejected_before_any_shared_file_changes() {
    let dir = tempfile::tempdir().unwrap();
    let storage = dir.path().join(".reviewbox");
    fs::create_dir_all(&storage).unwrap();
    let manifest = b"{\"format\":\"reviewbox\",\"version\":3,\"projectId\":\"old-project\"}\n";
    fs::write(storage.join("project.json"), manifest).unwrap();
    fs::write(
        storage.join("old-review.json"),
        b"legacy content stays byte-identical",
    )
    .unwrap();
    let error = match Project::open(dir.path(), "repository") {
        Ok(_) => panic!("v3 must be rejected"),
        Err(error) => error,
    };
    assert_eq!(error.code, "project_version");
    assert_eq!(fs::read(storage.join("project.json")).unwrap(), manifest);
    assert_eq!(
        fs::read(storage.join("old-review.json")).unwrap(),
        b"legacy content stays byte-identical"
    );
    assert!(!storage.join(".local").exists());
    assert!(!storage.join(".gitignore").exists());
}

fn directory_bytes(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    fn walk(root: &Path, directory: &Path, found: &mut BTreeMap<PathBuf, Vec<u8>>) {
        for entry in fs::read_dir(directory).unwrap() {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_dir() {
                walk(root, &entry.path(), found);
            } else {
                found.insert(
                    entry.path().strip_prefix(root).unwrap().into(),
                    fs::read(entry.path()).unwrap(),
                );
            }
        }
    }
    let mut found = BTreeMap::new();
    walk(root, root, &mut found);
    found
}

fn changed_publication_is_preserved(malformed: bool) {
    let (_dir, storage, repo) = fixture();
    let root = Path::new(&repo.path);
    fs::write(root.join("a.ts"), "first reviewed change\n").unwrap();
    let first = complete(&storage, &capture(&storage, &repo));
    git(root, &["add", "."]);
    git(root, &["commit", "-m", "publication A"]);
    let directory = root.join(format!(".reviewbox/published/{}", first.review.id));
    let metadata = directory.join(format!("reviews/{}/review.json", first.review.id));
    if malformed {
        fs::write(&metadata, b"an external editor left this invalid JSON\n").unwrap();
    } else {
        let mut value: Value = serde_json::from_slice(&fs::read(&metadata).unwrap()).unwrap();
        value["data"]["title"] = json!("External modification must remain intact");
        fs::write(&metadata, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
    }
    let original = directory_bytes(&directory);
    let index = fs::read(root.join(".git/index")).unwrap();
    storage.sync_projects(true).unwrap();
    fs::write(root.join("a.ts"), "second reviewed change\n").unwrap();
    let second = complete(&storage, &capture(&storage, &repo));
    assert_eq!(directory_bytes(&directory), original);
    assert_eq!(fs::read(root.join(".git/index")).unwrap(), index);
    assert!(
        second
            .review
            .publication
            .archive_deferred_reason
            .as_ref()
            .is_some_and(|reason| !reason.is_empty())
    );
    assert!(
        !root
            .join(format!(".reviewbox/references/{}.json", first.review.id))
            .exists()
    );
    assert!(
        root.join(format!(
            ".reviewbox/published/{}/bundle.json",
            second.review.id
        ))
        .exists()
    );
}

#[test]
fn external_valid_json_edit_does_not_block_new_publication_or_get_overwritten() {
    changed_publication_is_preserved(false);
}

#[test]
fn malformed_published_metadata_does_not_block_new_publication_or_get_overwritten() {
    changed_publication_is_preserved(true);
}

#[test]
fn proposals_stay_local_with_draft_then_follow_their_review_into_git_archive() {
    let (_dir, storage, repo) = fixture();
    let root = Path::new(&repo.path);
    fs::write(root.join("a.ts"), "first source with a proposal\n").unwrap();
    let first = capture(&storage, &repo);
    let proposal = Proposal {
        context_id: None,
        id: "applied-proposal".into(),
        review_id: first.review.id.clone(),
        snapshot_id: first.snapshot.id.clone(),
        run_id: None,
        content: ProposalContent::Glossary { terms: Vec::new() },
        status: "applied".into(),
        revision: 0,
        created_at: now(),
    };
    storage.insert("proposal", &proposal.id, &proposal).unwrap();
    assert_eq!(
        git(
            root,
            &[
                "status",
                "--porcelain",
                "--untracked-files=all",
                "--",
                ".reviewbox"
            ]
        ),
        ""
    );
    let first = complete(&storage, &first);
    git(root, &["add", "."]);
    git(root, &["commit", "-m", "review and its proposal"]);
    fs::write(root.join("a.ts"), "new source\n").unwrap();
    complete(&storage, &capture(&storage, &repo));
    assert!(
        root.join(format!(".reviewbox/references/{}.json", first.review.id))
            .exists()
    );
    assert!(storage.list::<Proposal>("proposal").unwrap().is_empty());
    let archived = reviews::load(&storage, &first.review.id).unwrap();
    assert_eq!(
        archived.review.publication.status,
        PublicationStatus::Archived
    );
    let archived_proposal: Proposal = storage.get("proposal", &proposal.id).unwrap();
    assert_eq!(archived_proposal.snapshot_id, first.snapshot.id);
}

#[test]
fn publications_from_two_merged_branches_archive_to_their_own_first_commits() {
    let (_dir, storage, repo) = fixture();
    let root = Path::new(&repo.path);
    let base = git(root, &["rev-parse", "HEAD"]);
    fs::write(root.join("a.ts"), "change from main\n").unwrap();
    let first = complete(&storage, &capture(&storage, &repo));
    git(root, &["add", "."]);
    git(root, &["commit", "-m", "main publication A"]);
    let first_commit = git(root, &["rev-parse", "HEAD"]);

    git(root, &["checkout", "-b", "parallel-publication", &base]);
    storage.sync_projects(true).unwrap();
    fs::write(root.join("image.bin"), [0, 7, 4, 0, 8]).unwrap();
    let second = complete(&storage, &capture(&storage, &repo));
    git(root, &["add", "."]);
    git(root, &["commit", "-m", "parallel publication B"]);
    let second_commit = git(root, &["rev-parse", "HEAD"]);

    git(root, &["checkout", "main"]);
    git(
        root,
        &[
            "merge",
            "--no-ff",
            "parallel-publication",
            "-m",
            "merge independent publications",
        ],
    );
    storage.sync_projects(true).unwrap();
    let published: Vec<Review> = storage.list("review").unwrap();
    assert_eq!(
        published
            .iter()
            .filter(|review| review.publication.status == PublicationStatus::Published)
            .count(),
        2
    );
    let index = fs::read(root.join(".git/index")).unwrap();
    fs::write(root.join("a.ts"), "next review after merge\n").unwrap();
    let third = complete(&storage, &capture(&storage, &repo));
    for (review_id, expected_commit) in [
        (&first.review.id, first_commit),
        (&second.review.id, second_commit),
    ] {
        let reference: Value = storage.get("review_reference", review_id).unwrap();
        assert_eq!(
            reference["publication"]["archive"]["commitId"],
            expected_commit
        );
        assert!(
            !root
                .join(format!(".reviewbox/published/{review_id}/bundle.json"))
                .exists()
        );
        let archived = reviews::load(&storage, review_id).unwrap();
        assert_eq!(
            archived.review.publication.status,
            PublicationStatus::Archived
        );
        assert!(
            snapshot_bytes(&storage, &archived.snapshot)
                .values()
                .any(|bytes| !bytes.is_empty())
        );
    }
    assert!(third.review.publication.archive_deferred_reason.is_none());
    assert!(
        root.join(format!(
            ".reviewbox/published/{}/bundle.json",
            third.review.id
        ))
        .exists()
    );
    assert_eq!(fs::read(root.join(".git/index")).unwrap(), index);
}

#[test]
fn committing_a_publication_updates_local_get_and_list_associations_without_bundle_writes() {
    let (dir, storage, repo) = fixture();
    let root = Path::new(&repo.path);
    fs::write(root.join("a.ts"), "reviewed before its future commit\n").unwrap();
    let first = complete(&storage, &capture(&storage, &repo));
    assert!(first.review.publication.matching_commit_ids.is_empty());
    let directory = root.join(format!(".reviewbox/published/{}", first.review.id));
    let original = directory_bytes(&directory);
    git(root, &["add", "."]);
    git(
        root,
        &["commit", "-m", "commit containing code and its review"],
    );
    let carrier = git(root, &["rev-parse", "HEAD"]);
    let index = fs::read(root.join(".git/index")).unwrap();
    let loaded: Review = storage.get("review", &first.review.id).unwrap();
    assert_eq!(
        loaded.publication.matching_commit_ids,
        vec![carrier.clone()]
    );
    let listed: Vec<Review> = storage.list("review").unwrap();
    assert_eq!(
        listed
            .iter()
            .find(|review| review.id == first.review.id)
            .unwrap()
            .publication
            .matching_commit_ids,
        vec![carrier.clone()]
    );
    assert_eq!(directory_bytes(&directory), original);
    assert_eq!(fs::read(root.join(".git/index")).unwrap(), index);
    let raw: Value = serde_json::from_slice(
        &fs::read(directory.join(format!("reviews/{}/review.json", first.review.id))).unwrap(),
    )
    .unwrap();
    assert_eq!(raw["data"]["publication"]["matchingCommitIds"], json!([]));
    assert_eq!(
        git(root, &["status", "--porcelain", "--", ".reviewbox"]),
        ""
    );

    // The private association cache is keyed by HEAD; moving HEAD to an empty
    // successor must still identify the actual reviewed commit, never itself.
    git(
        root,
        &["commit", "--allow-empty", "-m", "later empty commit"],
    );
    let loaded: Review = storage.get("review", &first.review.id).unwrap();
    assert_eq!(
        loaded.publication.matching_commit_ids,
        vec![carrier.clone()]
    );
    drop(storage);
    let reopened = Storage::open(dir.path().join("app")).unwrap();
    repositories::open(&reopened, &repo.path).unwrap();
    let listed: Vec<Review> = reopened.list("review").unwrap();
    assert_eq!(
        listed
            .iter()
            .find(|review| review.id == first.review.id)
            .unwrap()
            .publication
            .matching_commit_ids,
        vec![carrier]
    );
    assert_eq!(directory_bytes(&directory), original);
}

#[test]
fn publication_verifies_large_capture_with_git_and_shared_delta_pack() {
    let (_dir, storage, repo) = fixture();
    let root = Path::new(&repo.path);
    for i in 0..512 {
        fs::write(
            root.join(format!("source-{i}.ts")),
            format!("export const value = {i};\n"),
        )
        .unwrap();
    }
    git(root, &["add", "."]);
    git(root, &["commit", "-m", "many sources"]);
    for i in 0..32 {
        fs::write(
            root.join(format!("source-{i}.ts")),
            format!("export const value = {i};\n// changed\n"),
        )
        .unwrap();
    }
    let workspace = capture(&storage, &repo);
    let index = git(root, &["write-tree"]);
    let started = std::time::Instant::now();
    let published = complete(&storage, &workspace);
    eprintln!(
        "Published {} sources in {:?}",
        published.snapshot.files.len(),
        started.elapsed()
    );
    assert_eq!(git(root, &["write-tree"]), index);
    clear_source_cache(&storage);
    assert_eq!(
        snapshot_bytes(&storage, &published.snapshot),
        snapshot_bytes(&storage, &workspace.snapshot)
    );
}
