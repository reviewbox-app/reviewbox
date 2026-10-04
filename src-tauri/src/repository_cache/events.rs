use crate::contracts::{RepositoryReadChange, fingerprint};
use notify::{Event, EventKind, event::ModifyKind};
use std::path::Path;

pub(super) fn full(root: &Path) -> RepositoryReadChange {
    RepositoryReadChange {
        repository_id: fingerprint(root.to_string_lossy().as_bytes()),
        paths: Vec::new(),
        tree: true,
        git: true,
        full: true,
    }
}

pub(super) fn classify(root: &Path, event: notify::Result<Event>) -> Option<RepositoryReadChange> {
    let Ok(event) = event else {
        return Some(full(root));
    };
    if event.kind.is_access() {
        return None;
    }
    if event.need_rescan() || event.paths.is_empty() {
        return Some(full(root));
    }
    let mut change = RepositoryReadChange {
        tree: false,
        git: false,
        full: false,
        ..full(root)
    };
    for path in &event.paths {
        let relative = path.strip_prefix(root).ok();
        if relative.is_some_and(|p| p.starts_with(".reviewbox")) {
            continue;
        }
        let git_path = relative.and_then(|p| p.strip_prefix(".git").ok());
        if relative.is_none() || git_path.is_some() {
            // Linked worktree Git directories can live outside the checkout.
            // Objects, logs and transient locks don't change displayed Git state.
            if path.extension().is_some_and(|e| e == "lock") {
                continue;
            }
            if let Some(p) = git_path
                && (p.starts_with("objects") || p.starts_with("logs"))
            {
                continue;
            }
            change.git = true;
            change.tree = true;
            continue;
        }
        let relative = relative.unwrap();
        let Some(name) = relative.to_str() else {
            return Some(full(root));
        };
        if name.is_empty() {
            return Some(full(root));
        }
        if change.paths.len() >= 512 {
            return Some(full(root));
        }
        change.paths.push(name.replace('\\', "/"));
        change.tree |= !matches!(
            event.kind,
            EventKind::Modify(ModifyKind::Data(_) | ModifyKind::Metadata(_))
        ) || relative
            .file_name()
            .is_some_and(|n| n == ".gitignore" || n == ".ignore");
    }
    if change.paths.is_empty() && !change.git {
        None
    } else {
        Some(change)
    }
}

/// One bounded worker per watcher. Dropping the watcher closes its sender and
/// terminates the worker; filesystem callbacks never wait for the webview.
pub(super) fn batched(notify: super::Notifier) -> super::Notifier {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    };
    use std::time::{Duration, Instant};
    let (sender, receiver) = mpsc::sync_channel::<RepositoryReadChange>(64);
    let overflow = Arc::new(AtomicBool::new(false));
    let lost = overflow.clone();
    let deliver = notify.clone();
    let worker = std::thread::Builder::new()
        .name("repository-events".into())
        .spawn(move || {
            while let Ok(mut batch) = receiver.recv() {
                let deadline = Instant::now() + Duration::from_millis(200);
                let mut paths = batch
                    .paths
                    .iter()
                    .cloned()
                    .collect::<std::collections::BTreeSet<_>>();
                loop {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        break;
                    }
                    match receiver.recv_timeout(remaining) {
                        Ok(change) => {
                            batch.tree |= change.tree;
                            batch.git |= change.git;
                            batch.full |= change.full;
                            if !batch.full {
                                paths.extend(change.paths);
                                batch.full |= paths.len() > 512;
                            }
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => break,
                        Err(mpsc::RecvTimeoutError::Disconnected) => return,
                    }
                }
                batch.full |= lost.swap(false, Ordering::AcqRel);
                if batch.full {
                    batch.paths.clear();
                    batch.tree = true;
                    batch.git = true;
                } else {
                    batch.paths = paths.into_iter().collect();
                }
                deliver(batch);
            }
        });
    if worker.is_err() {
        return notify;
    }
    Arc::new(move |change| {
        if matches!(sender.try_send(change), Err(mpsc::TrySendError::Full(_))) {
            overflow.store(true, Ordering::Release);
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{DataChange, RenameMode};
    #[test]
    fn content_is_scoped_and_rename_updates_both_paths() {
        let root = Path::new("/checkout");
        let change = classify(
            root,
            Ok(
                Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Content)))
                    .add_path(root.join("src/a.rs")),
            ),
        )
        .unwrap();
        assert_eq!(change.paths, ["src/a.rs"]);
        assert!(!change.tree && !change.git && !change.full);
        let change = classify(
            root,
            Ok(
                Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
                    .add_path(root.join("src/a.rs"))
                    .add_path(root.join("src/b.rs")),
            ),
        )
        .unwrap();
        assert!(change.tree);
        assert_eq!(change.paths, ["src/a.rs", "src/b.rs"]);
    }
    #[test]
    fn bursts_are_batched_before_crossing_ipc() {
        use std::sync::{Arc, mpsc};
        use std::time::Duration;
        let (sender, receiver) = mpsc::channel();
        let send = batched(Arc::new(move |event| {
            sender.send(event).unwrap();
        }));
        for name in ["a.rs", "b.rs", "a.rs"] {
            send(RepositoryReadChange {
                paths: vec![name.into()],
                full: false,
                tree: false,
                git: false,
                ..full(Path::new("/checkout"))
            });
        }
        let event = receiver.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(event.paths, ["a.rs", "b.rs"]);
        assert!(!event.full);
        assert!(receiver.try_recv().is_err());
        drop(send);
        assert!(receiver.recv_timeout(Duration::from_secs(2)).is_err());
    }
    #[test]
    fn metadata_noise_and_git_are_separate() {
        let root = Path::new("/checkout");
        for path in [
            ".reviewbox/draft.json",
            ".git/index.lock",
            ".git/objects/ab/cd",
            ".git/logs/HEAD",
        ] {
            assert!(
                classify(
                    root,
                    Ok(Event::new(EventKind::Any).add_path(root.join(path)))
                )
                .is_none()
            );
        }
        let change = classify(
            root,
            Ok(Event::new(EventKind::Any).add_path(root.join(".git/index"))),
        )
        .unwrap();
        assert!(change.git && change.tree && !change.full);
        assert!(change.paths.is_empty());
        assert!(
            classify(root, Err(notify::Error::generic("lost events")))
                .unwrap()
                .full
        );
    }
}
