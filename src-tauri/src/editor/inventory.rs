//! Incremental directory snapshots. Ignored trees are listed, but only traversed on expansion.
use crate::contracts::{AppError, AppResult, EditorEntry, EditorWatchStatus, RepositoryReadChange};
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    time::Instant,
};

#[derive(Default)]
pub(crate) struct Inventories(BTreeMap<PathBuf, Inventory>);

#[derive(Clone)]
struct Child {
    path: PathBuf,
    directory: bool,
}
#[derive(Clone)]
struct Directory {
    children: Vec<Child>,
    git: Gitignore,
    custom: Gitignore,
}
struct Inventory {
    directories: BTreeMap<PathBuf, Directory>,
    global: Gitignore,
    exclude: Gitignore,
    generation: Option<String>,
    sequence: u64,
    touched: Instant,
    #[cfg(test)]
    directory_reads: usize,
}

impl Inventories {
    pub fn snapshot(
        &mut self,
        root: &Path,
        show_ignored: bool,
        expanded: &[String],
        change: Option<&RepositoryReadChange>,
        watch: Option<&EditorWatchStatus>,
    ) -> AppResult<Vec<EditorEntry>> {
        // Eight checkouts bound retained directory metadata independently of leases.
        if !self.0.contains_key(root)
            && self.0.len() >= 8
            && let Some(oldest) = self
                .0
                .iter()
                .min_by_key(|(_, value)| value.touched)
                .map(|(path, _)| path.clone())
        {
            self.0.remove(&oldest);
        }
        if watch.is_some_and(|watch| {
            !watch.healthy
                || self
                    .0
                    .get(root)
                    .is_some_and(|cached| cached.generation.as_ref() != Some(&watch.generation))
        }) {
            self.0.remove(root);
        }
        let inventory = self
            .0
            .entry(root.into())
            .or_insert_with(|| Inventory::new(root));
        inventory.invalidate(root, change);
        let expanded = expanded
            .iter()
            .map(|p| super::path(root, p))
            .collect::<AppResult<BTreeSet<_>>>()?;
        let mut entries = Vec::new();
        let rules = Rules {
            git: vec![inventory.global.clone(), inventory.exclude.clone()],
            custom: Vec::new(),
        };
        inventory.visit(root, root, false, &expanded, &rules, &mut entries)?;
        if !show_ignored {
            entries.retain(|entry| entry.ignored != Some(true));
        }
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        inventory.touched = Instant::now();
        if let Some(watch) = watch {
            inventory.generation = Some(watch.generation.clone());
        }
        Ok(entries)
    }
}

impl Inventory {
    fn new(root: &Path) -> Self {
        let global = GitignoreBuilder::new(root).build_global().0;
        let exclude_path =
            crate::repositories::text(root, &["rev-parse", "--git-path", "info/exclude"])
                .map(|p| root.join(p.trim()))
                .unwrap_or_else(|_| root.join(".git/info/exclude"));
        let mut exclude = GitignoreBuilder::new(root);
        let _ = exclude.add(exclude_path);
        Self {
            directories: BTreeMap::new(),
            global,
            exclude: exclude.build().unwrap_or_else(|_| Gitignore::empty()),
            generation: None,
            sequence: 0,
            touched: Instant::now(),
            #[cfg(test)]
            directory_reads: 0,
        }
    }
    fn invalidate(&mut self, root: &Path, change: Option<&RepositoryReadChange>) {
        let Some(change) = change else { return };
        let generation_changed = change.generation.is_some()
            && self.generation.is_some()
            && change.generation != self.generation;
        if change.full
            || generation_changed
            || change.git
            || change.paths.iter().any(|p| {
                !super::metadata_path(p)
                    && Path::new(p)
                        .file_name()
                        .is_some_and(|n| n == ".gitignore" || n == ".ignore")
            })
        {
            *self = Self::new(root);
        } else {
            for relative in &change.paths {
                if let Ok(path) = super::path(root, relative) {
                    if let Some(parent) = path.parent() {
                        self.directories.remove(parent);
                    }
                    self.directories.retain(|key, _| !key.starts_with(&path));
                }
            }
        }
        self.generation.clone_from(&change.generation);
        self.sequence = change.sequence.unwrap_or(self.sequence);
    }
    fn directory(&mut self, path: &Path) -> AppResult<Directory> {
        if let Some(snapshot) = self.directories.get(path) {
            return Ok(snapshot.clone());
        }
        let metadata = fs::symlink_metadata(path)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(AppError::new(
                "inventory_path",
                "A directory changed during inventory. Refresh to retry.",
            ));
        }
        #[cfg(test)]
        {
            self.directory_reads += 1;
        }
        let mut children = Vec::new();
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            if kind.is_symlink()
                || (path
                    .components()
                    .any(|part| part.as_os_str() == ".reviewbox")
                    && entry.file_name().to_string_lossy().starts_with(".tmp"))
                || matches!(entry.file_name().to_str(), Some(".git"))
                || entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".reviewbox-save-")
            {
                continue;
            }
            if kind.is_file() || kind.is_dir() {
                children.push(Child {
                    path: entry.path(),
                    directory: kind.is_dir(),
                });
            }
        }
        children.sort_by(|a, b| a.path.cmp(&b.path));
        let snapshot = Directory {
            children,
            git: Gitignore::new(path.join(".gitignore")).0,
            custom: Gitignore::new(path.join(".ignore")).0,
        };
        self.directories.insert(path.into(), snapshot.clone());
        Ok(snapshot)
    }
    fn visit(
        &mut self,
        root: &Path,
        directory: &Path,
        parent_ignored: bool,
        expanded: &BTreeSet<PathBuf>,
        parent_rules: &Rules,
        result: &mut Vec<EditorEntry>,
    ) -> AppResult<bool> {
        let snapshot = self.directory(directory)?;
        let mut rules = parent_rules.clone();
        rules.git.push(snapshot.git);
        rules.custom.push(snapshot.custom);
        let mut all_ignored = !snapshot.children.is_empty();
        for child in snapshot.children {
            let excluded = parent_ignored || rules.ignored(&child.path, child.directory);
            let mut ignored = excluded;
            let relative = child
                .path
                .strip_prefix(root)
                .ok()
                .and_then(Path::to_str)
                .ok_or_else(|| AppError::new("unsupported_path", "A file name is not UTF-8."))?
                .replace('\\', "/");
            let lazy = child.directory
                && (ignored || super::metadata_path(&relative))
                && !expanded
                    .iter()
                    .any(|p| p == &child.path || p.starts_with(&child.path));
            if child.directory && !lazy {
                let children_ignored =
                    self.visit(root, &child.path, ignored, expanded, &rules, result)?;
                ignored |= children_ignored;
            }
            all_ignored &= ignored;
            result.push(EditorEntry {
                path: relative,
                directory: child.directory,
                revision: String::new(),
                ignored: Some(ignored),
                excluded: Some(excluded),
                lazy: Some(lazy),
            });
        }
        Ok(all_ignored)
    }
}

#[derive(Clone)]
struct Rules {
    git: Vec<Gitignore>,
    custom: Vec<Gitignore>,
}
impl Rules {
    fn ignored(&self, path: &Path, directory: bool) -> bool {
        // .ignore rules have precedence over Git rules, like ignore::WalkBuilder.
        for rules in [&self.custom, &self.git] {
            for rule in rules.iter().rev() {
                let matched = rule.matched(path, directory);
                if !matched.is_none() {
                    return matched.is_ignore();
                }
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reviewbox_is_visible_and_each_metadata_subtree_is_lazy() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join(".reviewbox/published/example")).unwrap();
        fs::create_dir_all(root.join(".reviewbox/.local")).unwrap();
        fs::write(root.join(".reviewbox/.gitignore"), ".local/\n").unwrap();
        fs::write(root.join(".reviewbox/settings.json"), "{}").unwrap();
        fs::write(
            root.join(".reviewbox/published/example/content.md"),
            "capture",
        )
        .unwrap();
        let mut inventories = Inventories::default();
        let closed = inventories.snapshot(root, true, &[], None, None).unwrap();
        assert!(
            closed
                .iter()
                .any(|e| e.path == ".reviewbox" && e.lazy == Some(true))
        );
        assert!(!closed.iter().any(|e| e.path == ".reviewbox/settings.json"));
        let opened = inventories
            .snapshot(root, true, &[".reviewbox".into()], None, None)
            .unwrap();
        assert!(opened.iter().any(|e| e.path == ".reviewbox/settings.json"));
        assert!(
            opened
                .iter()
                .any(|e| e.path == ".reviewbox/published" && e.lazy == Some(true))
        );
        assert!(!opened.iter().any(|e| e.path.ends_with("content.md")));
    }

    #[test]
    fn expanded_excluded_directories_are_distinct_from_ignored_only_parents() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::write(root.join(".gitignore"), "vendor/\n*.tmp\n").unwrap();
        fs::create_dir_all(root.join("vendor/nested")).unwrap();
        fs::create_dir(root.join("source")).unwrap();
        fs::write(root.join("vendor/nested/a.rs"), "excluded").unwrap();
        fs::write(root.join("source/cache.tmp"), "ignored").unwrap();
        let mut state = Inventories::default();
        let entries = state
            .snapshot(root, true, &["vendor/nested".into()], None, None)
            .unwrap();
        for path in ["vendor", "vendor/nested", "vendor/nested/a.rs"] {
            let entry = entries.iter().find(|entry| entry.path == path).unwrap();
            assert_eq!(entry.ignored, Some(true));
            assert_eq!(entry.excluded, Some(true));
            assert_eq!(entry.lazy, Some(false));
        }
        let source = entries.iter().find(|entry| entry.path == "source").unwrap();
        assert_eq!(source.ignored, Some(true));
        assert_eq!(source.excluded, Some(false));
        assert_eq!(source.lazy, Some(false));
        let file = entries
            .iter()
            .find(|entry| entry.path == "source/cache.tmp")
            .unwrap();
        assert_eq!(file.excluded, Some(true));
    }

    #[test]
    fn ignored_subtrees_are_lazy_and_empty_directories_remain_visible() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::write(root.join(".gitignore"), "vendor/\n*.tmp\n").unwrap();
        fs::write(root.join(".ignore"), "custom/\n").unwrap();
        for name in ["vendor", "empty", "only", "custom"] {
            fs::create_dir(root.join(name)).unwrap();
        }
        fs::write(root.join("vendor/a.rs"), "a").unwrap();
        fs::write(root.join("custom/a.rs"), "a").unwrap();
        fs::write(root.join("only/a.tmp"), "a").unwrap();
        let mut state = Inventories::default();
        let first = state.snapshot(root, true, &[], None, None).unwrap();
        assert!(
            first
                .iter()
                .any(|e| e.path == "vendor" && e.lazy == Some(true) && e.ignored == Some(true))
        );
        assert!(!first.iter().any(|e| e.path == "vendor/a.rs"));
        assert!(
            first
                .iter()
                .any(|e| e.path == "only" && e.ignored == Some(true))
        );
        assert!(
            first
                .iter()
                .any(|e| e.path == "empty" && e.ignored == Some(false))
        );
        let expanded = state
            .snapshot(root, true, &["vendor".into()], None, None)
            .unwrap();
        assert!(
            expanded
                .iter()
                .any(|e| e.path == "vendor/a.rs" && e.ignored == Some(true))
        );
        let visible = state.snapshot(root, false, &[], None, None).unwrap();
        assert!(!visible.iter().any(|e| e.ignored == Some(true)));
    }
    #[test]
    fn structural_change_invalidates_parent_but_preserves_unrelated_snapshots() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        for name in ["a", "b"] {
            fs::create_dir(root.join(name)).unwrap();
        }
        let mut state = Inventories::default();
        state.snapshot(root, true, &[], None, None).unwrap();
        fs::write(root.join("a/new"), "new").unwrap();
        let change = RepositoryReadChange {
            repository_id: "test".into(),
            paths: vec!["a/new".into()],
            tree: true,
            git: false,
            full: false,
            generation: None,
            sequence: None,
            changes: None,
        };
        let result = state
            .snapshot(root, true, &[], Some(&change), None)
            .unwrap();
        assert!(result.iter().any(|e| e.path == "a/new"));
        assert!(
            state
                .0
                .get(root)
                .unwrap()
                .directories
                .contains_key(&root.join("b"))
        );
    }
}

/// Shared rule cache for targeted searches and unsaved files absent from disk.
pub(crate) struct Exclusions {
    root: PathBuf,
    base: Rules,
    directories: BTreeMap<PathBuf, (Gitignore, Gitignore)>,
}
impl Exclusions {
    pub fn new(root: &Path) -> Self {
        let inventory = Inventory::new(root);
        Self {
            root: root.into(),
            base: Rules {
                git: vec![inventory.global, inventory.exclude],
                custom: Vec::new(),
            },
            directories: BTreeMap::new(),
        }
    }
    pub fn ignored(&mut self, path: &Path) -> AppResult<bool> {
        let mut rules = self.base.clone();
        let relative = path
            .strip_prefix(&self.root)
            .map_err(|e| AppError::new("invalid_path", e.to_string()))?;
        let mut current = self.root.clone();
        for component in relative.components() {
            let (git, custom) = self.directories.entry(current.clone()).or_insert_with(|| {
                (
                    Gitignore::new(current.join(".gitignore")).0,
                    Gitignore::new(current.join(".ignore")).0,
                )
            });
            rules.git.push(git.clone());
            rules.custom.push(custom.clone());
            current.push(component);
            if rules.ignored(&current, current != path || current.is_dir()) {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

#[cfg(test)]
mod performance {
    use super::*;
    use std::time::Instant;
    #[test]
    fn synthetic_small_repository_reuses_snapshots_and_refreshes_one_directory() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        assert!(
            std::process::Command::new("git")
                .args(["init", "-q"])
                .current_dir(root)
                .status()
                .unwrap()
                .success()
        );
        fs::write(root.join(".gitignore"), "target/\n").unwrap();
        for directory in ["src", "tests", "docs"] {
            let dir = root.join(directory);
            fs::create_dir_all(&dir).unwrap();
            for file in 0..5 {
                fs::write(dir.join(format!("file{file}.txt")), "source\n").unwrap();
            }
        }
        fs::create_dir(root.join("empty")).unwrap();
        fs::create_dir_all(root.join("target/debug")).unwrap();
        for file in 0..10 {
            fs::write(
                root.join(format!("target/debug/artifact{file}")),
                "ignored\n",
            )
            .unwrap();
        }
        let baseline = Instant::now();
        let eager = crate::editor::inventory(root, true).unwrap();
        let visible = crate::editor::inventory(root, false).unwrap();
        let baseline_elapsed = baseline.elapsed();
        let mut state = Inventories::default();
        let cold = Instant::now();
        let snapshot = state.snapshot(root, true, &[], None, None).unwrap();
        let cold_elapsed = cold.elapsed();
        let reads = state.0.get(root).unwrap().directory_reads;
        let warm = Instant::now();
        state.snapshot(root, true, &[], None, None).unwrap();
        let warm_elapsed = warm.elapsed();
        assert_eq!(state.0.get(root).unwrap().directory_reads, reads);
        assert!(snapshot.iter().any(|entry| entry.path == "empty"));
        assert!(
            !snapshot
                .iter()
                .any(|entry| entry.path.starts_with("target/"))
        );
        fs::write(root.join("src/new.txt"), "new source\n").unwrap();
        let change = RepositoryReadChange {
            repository_id: "small-bench".into(),
            paths: vec!["src/new.txt".into()],
            tree: true,
            git: false,
            full: false,
            generation: None,
            sequence: None,
            changes: None,
        };
        let update = Instant::now();
        let updated = state
            .snapshot(root, true, &[], Some(&change), None)
            .unwrap();
        let update_elapsed = update.elapsed();
        assert_eq!(state.0.get(root).unwrap().directory_reads, reads + 1);
        assert_eq!(updated.len(), snapshot.len() + 1);
        assert!(updated.iter().any(|entry| entry.path == "src/new.txt"));
        eprintln!(
            "small repository inventory fixture: baseline two walks {:?} ({}+{} entries), cold {:?} ({} entries/{} dir reads), warm {:?} (0 reads), one-path {:?} (1 read)",
            baseline_elapsed,
            eager.len(),
            visible.len(),
            cold_elapsed,
            snapshot.len(),
            reads,
            warm_elapsed,
            update_elapsed
        );
    }

    #[test]
    fn synthetic_monorepo_reuses_directory_snapshots_and_prunes_ignored_trees() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(root)
            .status()
            .unwrap();
        fs::write(root.join(".gitignore"), "node_modules/\n").unwrap();
        for project in 0..20 {
            let src = root.join(format!("packages/p{project}/src"));
            fs::create_dir_all(&src).unwrap();
            for file in 0..15 {
                fs::write(src.join(format!("file{file}.rs")), "needle source\n").unwrap();
            }
        }
        for dependency in 0..80 {
            let dir = root.join(format!("node_modules/p{dependency}"));
            fs::create_dir_all(&dir).unwrap();
            for file in 0..10 {
                fs::write(dir.join(format!("file{file}.js")), "ignored needle\n").unwrap();
            }
        }
        let baseline = Instant::now();
        let eager = crate::editor::inventory(root, true).unwrap();
        let visible = crate::editor::inventory(root, false).unwrap();
        let baseline_elapsed = baseline.elapsed();
        let mut state = Inventories::default();
        let cold = Instant::now();
        let snapshot = state.snapshot(root, true, &[], None, None).unwrap();
        let cold_elapsed = cold.elapsed();
        let reads = state.0.get(root).unwrap().directory_reads;
        let warm = Instant::now();
        state.snapshot(root, true, &[], None, None).unwrap();
        let warm_elapsed = warm.elapsed();
        assert_eq!(state.0.get(root).unwrap().directory_reads, reads);
        fs::write(root.join("packages/p0/src/new.rs"), "needle new").unwrap();
        let change = RepositoryReadChange {
            repository_id: "bench".into(),
            paths: vec!["packages/p0/src/new.rs".into()],
            tree: true,
            git: false,
            full: false,
            generation: None,
            sequence: None,
            changes: None,
        };
        let update = Instant::now();
        let updated = state
            .snapshot(root, true, &[], Some(&change), None)
            .unwrap();
        let update_elapsed = update.elapsed();
        assert_eq!(state.0.get(root).unwrap().directory_reads, reads + 1);
        assert!(updated.iter().any(|e| e.path == "packages/p0/src/new.rs"));
        assert!(!snapshot.iter().any(|e| e.path.starts_with("node_modules/")));
        eprintln!(
            "inventory fixture: baseline two walks {:?} ({}+{} entries), cold {:?} ({} entries/{} dir reads), warm {:?} (0 reads), one-path {:?} (1 read)",
            baseline_elapsed,
            eager.len(),
            visible.len(),
            cold_elapsed,
            snapshot.len(),
            reads,
            warm_elapsed,
            update_elapsed
        );
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    #[test]
    fn checkout_cache_is_bounded_and_watch_generation_reconciles_a_gap() {
        let temp = tempfile::tempdir().unwrap();
        let mut state = Inventories::default();
        for i in 0..10 {
            let root = temp.path().join(format!("r{i}"));
            fs::create_dir(&root).unwrap();
            state.snapshot(&root, true, &[], None, None).unwrap();
        }
        assert_eq!(state.0.len(), 8);
        assert!(!state.0.contains_key(&temp.path().join("r0")));
        let root = temp.path().join("r9");
        let mut watch = EditorWatchStatus {
            healthy: true,
            generation: "one".into(),
            sequence: 0,
        };
        state
            .snapshot(&root, true, &[], None, Some(&watch))
            .unwrap();
        fs::write(root.join("created-while-stopped"), "new").unwrap();
        watch.generation = "two".into();
        assert!(
            state
                .snapshot(&root, true, &[], None, Some(&watch))
                .unwrap()
                .iter()
                .any(|entry| entry.path == "created-while-stopped")
        );
        fs::write(root.join("without-watcher"), "new").unwrap();
        watch.healthy = false;
        assert!(
            state
                .snapshot(&root, true, &[], None, Some(&watch))
                .unwrap()
                .iter()
                .any(|entry| entry.path == "without-watcher")
        );
    }
}
