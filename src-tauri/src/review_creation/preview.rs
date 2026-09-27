use crate::{
    contracts::*,
    repositories::{git, resolve, root, text},
    snapshots::{EMPTY_TREE, MAX_FILE, comparison_refs, content_is_binary, is_metadata, safe_path},
    storage::Storage,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};

#[derive(Clone, Default)]
struct FileStat {
    additions: u32,
    deletions: u32,
    binary: bool,
}
type Stats = BTreeMap<String, FileStat>;

fn string(bytes: &[u8]) -> AppResult<String> {
    String::from_utf8(bytes.to_vec())
        .map_err(|_| AppError::new("unsupported_path", "A repository filename is not UTF-8."))
}

fn read_working(root: &Path, path: &str) -> AppResult<Vec<u8>> {
    safe_path(path)?;
    let file = root.join(path);
    let metadata = match fs::symlink_metadata(&file) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    if let Some(parent) = file.parent()
        && !parent.canonicalize()?.starts_with(root)
    {
        return Err(AppError::new(
            "external_path",
            format!("{path} points outside the repository."),
        ));
    }
    if metadata.len() > MAX_FILE {
        return Err(AppError::new(
            "large_file",
            format!("{path} exceeds the 64 MiB capture limit."),
        ));
    }
    if metadata.is_symlink() {
        Ok(fs::read_link(&file)?.to_string_lossy().as_bytes().to_vec())
    } else if metadata.is_dir() {
        // Submodules are classified by mode and require no directory traversal.
        Ok(Vec::new())
    } else {
        Ok(fs::read(file)?)
    }
}

fn read_object(root: &Path, mode: &str, oid: &str) -> AppResult<Vec<u8>> {
    if mode == "000000" {
        return Ok(Vec::new());
    }
    if mode == "160000" {
        return Ok(oid.as_bytes().to_vec());
    }
    let size: u64 = text(root, &["cat-file", "-s", oid])?
        .parse()
        .map_err(|_| AppError::new("git", "Invalid Git object size."))?;
    if size > MAX_FILE {
        return Err(AppError::new(
            "large_file",
            "A changed file exceeds the 64 MiB capture limit.",
        ));
    }
    git(root, &["cat-file", "blob", oid])
}

fn content_stat(before: &[u8], after: &[u8], before_mode: &str, after_mode: &str) -> FileStat {
    let binary = content_is_binary(before, after, Some(before_mode), Some(after_mode));
    if binary {
        return FileStat {
            binary,
            ..FileStat::default()
        };
    }
    let old = std::str::from_utf8(before).unwrap_or_default();
    let new = std::str::from_utf8(after).unwrap_or_default();
    let diff = similar::TextDiff::from_lines(old, new);
    let mut stat = FileStat::default();
    for op in diff.ops() {
        if op.tag() != similar::DiffTag::Equal {
            stat.additions += op.new_range().len() as u32;
            stat.deletions += op.old_range().len() as u32;
        }
    }
    stat
}

fn diff(root: &Path, references: &[&str], cached: bool) -> AppResult<Stats> {
    let mut args = vec![
        "diff",
        "--raw",
        "-z",
        "--no-abbrev",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        "--ignore-submodules=none",
    ];
    if cached {
        args.push("--cached");
    }
    args.extend_from_slice(references);
    args.extend(["--", ".", ":(exclude).reviewbox", ":(exclude).reviewbox/**"]);
    let data = git(root, &args)?;
    let mut entries = data.split(|b| *b == 0).filter(|p| !p.is_empty());
    let mut stats = Stats::new();
    while let Some(raw) = entries.next() {
        let metadata = string(raw)?;
        let fields: Vec<_> = metadata
            .trim_start_matches(':')
            .split_whitespace()
            .collect();
        let path = string(
            entries
                .next()
                .ok_or_else(|| AppError::new("git", "Missing changed path."))?,
        )?;
        if is_metadata(&path) {
            continue;
        }
        safe_path(&path)?;
        if fields.len() != 5 {
            return Err(AppError::new("git", "Malformed change metadata."));
        }
        if fields[4] == "U" {
            return Err(AppError::new(
                "merge_conflict",
                "Resolve the index conflicts before capturing a review.",
            ));
        }
        // Snapshot capture preserves index gitlinks without traversing submodule
        // working directories. Dirty contents or a checked-out child HEAD alone
        // therefore do not create an unstaged change here either.
        if !cached
            && references.is_empty()
            && fields[0] == "160000"
            && fields[1] == "160000"
            && root.join(&path).is_dir()
        {
            continue;
        }
        let before = read_object(root, fields[0], fields[2])?;
        let after = if !cached && references.is_empty() {
            read_working(root, &path)?
        } else {
            read_object(root, fields[1], fields[3])?
        };
        stats.insert(path, content_stat(&before, &after, fields[0], fields[1]));
    }
    Ok(stats)
}

fn untracked(root: &Path) -> AppResult<Vec<String>> {
    git(root, &["ls-files", "--others", "--exclude-standard", "-z"])?
        .split(|b| *b == 0)
        .filter(|b| !b.is_empty())
        .map(string)
        .filter(|path| path.as_ref().is_err() || path.as_ref().is_ok_and(|path| !is_metadata(path)))
        .collect()
}

fn untracked_stats(root: &Path, paths: &[String]) -> AppResult<Stats> {
    let mut stats = Stats::new();
    for path in paths {
        safe_path(path)?;
        if fs::symlink_metadata(root.join(path))?.is_dir() {
            continue;
        }
        let bytes = read_working(root, path)?;
        stats.insert(path.clone(), content_stat(&[], &bytes, "000000", "100644"));
    }
    Ok(stats)
}

fn summarize(scope: Scope, layers: &[&Stats], partially_staged_files: u32) -> ScopePreview {
    let files: BTreeSet<_> = layers.iter().flat_map(|layer| layer.keys()).collect();
    let binary: BTreeSet<_> = layers
        .iter()
        .flat_map(|layer| layer.iter().filter(|(_, f)| f.binary).map(|(p, _)| p))
        .collect();
    ScopePreview {
        scope,
        files: files.len() as u32,
        additions: layers
            .iter()
            .flat_map(|s| s.values())
            .map(|s| s.additions)
            .sum(),
        deletions: layers
            .iter()
            .flat_map(|s| s.values())
            .map(|s| s.deletions)
            .sum(),
        binary_files: binary.len() as u32,
        partially_staged_files,
        commit_count: None,
        base: None,
        target: None,
        error: None,
    }
}

fn committed(root: &Path, request: &CaptureRequest, scope: Scope) -> ScopePreview {
    let result = (|| -> AppResult<ScopePreview> {
        let comparison = CaptureRequest {
            scope: scope.clone(),
            ..request.clone()
        };
        let (base, target) = comparison_refs(root, &comparison)?;
        let stats = diff(root, &[&base, &target], false)?;
        let mut preview = summarize(scope.clone(), &[&stats], 0);
        preview.commit_count = Some(if scope == Scope::Commit {
            1
        } else {
            text(root, &["rev-list", "--count", &format!("{base}..{target}")])?
                .parse()
                .map_err(|_| AppError::new("git", "Invalid commit count."))?
        });
        preview.base = Some(base);
        preview.target = Some(target);
        Ok(preview)
    })();
    result.unwrap_or_else(|error| {
        let mut item = summarize(scope, &[], 0);
        item.error = Some(error.message);
        item
    })
}

/// Read-only Git inspection. No snapshots, blob cache, project settings or index
/// entries are created by previewing the creation wizard.
pub fn preview(storage: &Storage, request: &CaptureRequest) -> AppResult<ReviewPreview> {
    let root = root(storage, &request.repository_id)?;
    let head = resolve(&root, "HEAD").unwrap_or_else(|_| EMPTY_TREE.into());
    let staged = diff(&root, &[&head], true);
    let paths = untracked(&root).map(|paths| {
        paths
            .into_iter()
            .filter(|path| {
                // An embedded untracked repository is a directory, not a captured file.
                !fs::symlink_metadata(root.join(path)).is_ok_and(|metadata| metadata.is_dir())
            })
            .collect::<Vec<_>>()
    });
    let untracked_files = paths.as_ref().map_or(0, |paths| paths.len() as u32);
    let unstaged = diff(&root, &[], false).and_then(|mut stats| {
        if request.include_untracked {
            let paths = paths.as_ref().map_err(Clone::clone)?;
            stats.extend(untracked_stats(&root, paths)?);
        }
        Ok(stats)
    });
    let partially_staged = match (&staged, &unstaged) {
        (Ok(staged), Ok(unstaged)) => staged
            .keys()
            .filter(|path| unstaged.contains_key(*path))
            .count() as u32,
        _ => 0,
    };
    let unavailable = |scope, error: &AppError| {
        let mut preview = summarize(scope, &[], 0);
        preview.error = Some(error.message.clone());
        preview
    };
    let local = match (&staged, &unstaged) {
        (Ok(staged), Ok(unstaged)) => {
            summarize(Scope::Local, &[staged, unstaged], partially_staged)
        }
        (Err(error), _) | (_, Err(error)) => unavailable(Scope::Local, error),
    };
    // Each scope owns only its participating layers. A broken or oversized local
    // file must not hide a valid immutable commit comparison or staged capture.
    let unstaged = match &unstaged {
        Ok(stats) => summarize(Scope::Unstaged, &[stats], partially_staged),
        Err(error) => unavailable(Scope::Unstaged, error),
    };
    let staged = match &staged {
        Ok(stats) => summarize(Scope::Staged, &[stats], partially_staged),
        Err(error) => unavailable(Scope::Staged, error),
    };
    Ok(ReviewPreview {
        untracked_files,
        scopes: vec![
            local,
            unstaged,
            staged,
            committed(&root, request, Scope::Commit),
            committed(&root, request, Scope::Range),
        ],
    })
}

pub fn references(
    storage: &Storage,
    repository_id: &str,
    query: &str,
) -> AppResult<Vec<RepositoryRef>> {
    if query.len() > 1024 {
        return Err(AppError::new(
            "invalid_reference",
            "Reference search is too long.",
        ));
    }
    let root = root(storage, repository_id)?;
    let needle = query.trim().to_lowercase();
    let mut refs = Vec::new();
    let data = text(
        &root,
        &[
            "for-each-ref",
            "--count=1000",
            "--sort=-committerdate",
            "--format=%(refname)%00%(objectname)%00%(subject)",
            "refs/heads",
            "refs/tags",
        ],
    )?;
    for line in data.lines() {
        let fields: Vec<_> = line.splitn(3, '\0').collect();
        if fields.len() != 3 {
            continue;
        }
        let (kind, name) = if let Some(name) = fields[0].strip_prefix("refs/heads/") {
            ("branch", name)
        } else if let Some(name) = fields[0].strip_prefix("refs/tags/") {
            ("tag", name)
        } else {
            continue;
        };
        if !format!("{name} {} {}", fields[1], fields[2])
            .to_lowercase()
            .contains(&needle)
        {
            continue;
        }
        let Ok(oid) = resolve(&root, fields[0]) else {
            continue;
        };
        refs.push(RepositoryRef {
            name: name.into(),
            oid,
            kind: kind.into(),
            summary: Some(fields[2].into()),
        });
    }
    if let Ok(data) = text(&root, &["log", "--all", "-200", "--format=%H%x00%s"]) {
        for line in data.lines() {
            let Some((oid, subject)) = line.split_once('\0') else {
                continue;
            };
            if !format!("{oid} {subject}").to_lowercase().contains(&needle) {
                continue;
            }
            refs.push(RepositoryRef {
                name: oid[..7.min(oid.len())].into(),
                oid: oid.into(),
                kind: "commit".into(),
                summary: Some(subject.into()),
            });
        }
    }
    if !query.trim().is_empty()
        && let Ok(oid) = resolve(&root, query.trim())
        && !refs.iter().any(|r| r.oid == oid)
    {
        refs.insert(
            0,
            RepositoryRef {
                name: query.trim().into(),
                summary: text(&root, &["show", "-s", "--format=%s", &oid]).ok(),
                oid,
                kind: "commit".into(),
            },
        );
    }
    refs.truncate(100);
    Ok(refs)
}
