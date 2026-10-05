//! Opt-in real-provider benchmark against an explicitly isolated capture copy.
use super::*;

#[test]
#[ignore = "uses a real provider; requires an isolated replay directory"]
fn replay_isolated_capture() {
    let root = PathBuf::from(std::env::var("REVIEWBOX_REPLAY_ROOT").expect("isolated replay root"));
    assert!(root.join("isolated-replay.marker").is_file());
    let repo = root.join("repo").canonicalize().unwrap();
    assert!(repo.starts_with(root.canonicalize().unwrap()));
    let storage = Storage::open(root.join("appdata")).unwrap();
    let repository = crate::repositories::open(&storage, repo.to_str().unwrap()).unwrap();
    let storage = storage.scoped(Some(&repository.id));
    let baseline: Value =
        serde_json::from_slice(&std::fs::read(root.join("baseline.json")).unwrap()).unwrap();
    let review_id = baseline["state"]["reviewId"].as_str().unwrap();
    let workspace = reviews::load(&storage, review_id).unwrap();
    assert_eq!(workspace.snapshot.id, baseline["state"]["snapshotId"]);
    assert!(
        workspace.review.topics.is_empty(),
        "Reset the isolated draft before benchmarking; previous documents bias the result"
    );
    assert!(
        optional_checkpoint(&storage, &format!("{}:{review_id}", repository.id))
            .unwrap()
            .is_none(),
        "Use fresh private preparation state for a benchmark"
    );
    let mut settings = agents::settings(&storage).unwrap();
    settings.helper_model = "gpt-6-luna".into();
    let config = settings
        .providers
        .iter_mut()
        .find(|p| p.provider == "codex")
        .unwrap();
    config.executable =
        std::env::var("REVIEWBOX_REPLAY_CODEX").expect("explicit real Codex executable");
    config.model = Some("gpt-6.1-sol".into());
    agents::configure(&storage, settings).unwrap();
    let manager = PreparationManager::default();
    manager
        .start(
            storage.clone(),
            tests::native::resources(),
            PreparationRequest {
                review_id: review_id.into(),
                provider: "codex".into(),
            },
        )
        .unwrap();
    let started = std::time::Instant::now();
    let mut previous = String::new();
    loop {
        let state = manager.get(&storage, review_id, None).unwrap().unwrap();
        let progress = format!(
            "{:?}: {}/{}",
            state.phase, state.completed_batches, state.total_batches
        );
        if previous != progress {
            eprintln!("{}s {progress}", started.elapsed().as_secs());
            previous = progress;
        }
        if state.status != PreparationStatus::Running {
            let checkpoint: Checkpoint = storage
                .get(KIND, &format!("{}:{review_id}", repository.id))
                .unwrap();
            std::fs::write(
                root.join("checkpoint.json"),
                serde_json::to_vec_pretty(&checkpoint).unwrap(),
            )
            .unwrap();
            assert_eq!(state.status, PreparationStatus::Ready, "{:?}", state.error);
            let result = reviews::load(&storage, review_id).unwrap();
            std::fs::write(
                root.join("result.json"),
                serde_json::to_vec_pretty(&result).unwrap(),
            )
            .unwrap();
            break;
        }
        if started.elapsed().as_secs() > 1800 {
            manager.cancel(&storage, review_id).unwrap();
            panic!("Replay exceeded 30 minutes; cancelled");
        }
        std::thread::sleep(std::time::Duration::from_secs(2));
    }
}
