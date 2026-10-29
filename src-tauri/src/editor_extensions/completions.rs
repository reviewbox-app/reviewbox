//! Bounded fallback for resources and package specifiers not covered by a language server.
use crate::{contracts::*, storage::Storage};
use std::{
    collections::BTreeMap,
    fs,
    path::{Component, Path, PathBuf},
};

fn manifest(path: &Path) -> Option<serde_json::Value> {
    if fs::metadata(path).ok()?.len() > 1024 * 1024 {
        return None;
    }
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}
fn normalize(root: &Path, from: &Path, prefix: &str) -> Option<PathBuf> {
    let mut path = from.to_path_buf();
    for part in Path::new(prefix).components() {
        match part {
            Component::Normal(name) => path.push(name),
            Component::CurDir => {}
            Component::ParentDir => {
                path.pop();
            }
            _ => return None,
        }
        if !path.starts_with(root) {
            return None;
        }
    }
    let path = path.canonicalize().ok()?;
    path.starts_with(root).then_some(path)
}
pub(super) fn suggestions(
    root: &Path,
    relative: &str,
    prefix: &str,
    packages: bool,
) -> AppResult<Vec<EditorPathSuggestion>> {
    if prefix.len() > 2048 || prefix.contains(['\0', '\\']) {
        return Ok(vec![]);
    }
    let file = crate::editor::path(root, relative)?;
    let parent = file.parent().unwrap_or(root);
    let mut values = BTreeMap::new();
    if packages {
        for directory in parent.ancestors().take_while(|p| p.starts_with(root)) {
            let Some(package) = manifest(&directory.join("package.json")) else {
                continue;
            };
            for section in [
                "dependencies",
                "devDependencies",
                "peerDependencies",
                "optionalDependencies",
            ] {
                for name in package[section]
                    .as_object()
                    .into_iter()
                    .flat_map(|o| o.keys())
                {
                    if name.starts_with(prefix) {
                        values.insert(
                            name.clone(),
                            EditorPathSuggestion {
                                label: name.clone(),
                                directory: false,
                                package: true,
                            },
                        );
                    }
                }
            }
            let patterns = package["workspaces"]
                .as_array()
                .or_else(|| package["workspaces"]["packages"].as_array());
            for pattern in patterns
                .into_iter()
                .flatten()
                .filter_map(|p| p.as_str())
                .take(50)
            {
                // Only enumerate a workspace's named directory, never crawl the checkout.
                let (base, wildcard) = pattern
                    .strip_suffix("/*")
                    .map_or((pattern, false), |p| (p, true));
                let Some(base) = normalize(root, directory, base) else {
                    continue;
                };
                let folders = if wildcard {
                    fs::read_dir(base)?
                        .flatten()
                        .take(300)
                        .map(|e| e.path())
                        .collect::<Vec<_>>()
                } else {
                    vec![base]
                };
                for folder in folders {
                    if !folder.canonicalize().is_ok_and(|p| p.starts_with(root)) {
                        continue;
                    }
                    if let Some(name) = manifest(&folder.join("package.json"))
                        .and_then(|p| p["name"].as_str().map(str::to_owned))
                        .filter(|n| n.starts_with(prefix))
                    {
                        values.insert(
                            name.clone(),
                            EditorPathSuggestion {
                                label: name,
                                directory: false,
                                package: true,
                            },
                        );
                    }
                }
            }
        }
    } else {
        let (base, partial) = prefix.rsplit_once('/').map_or((".", prefix), |(b, p)| {
            (if b.is_empty() { "." } else { b }, p)
        });
        let base = if prefix.starts_with('/') {
            normalize(root, root, base.trim_start_matches('/'))
        } else {
            normalize(root, parent, base)
        };
        if let Some(base) = base
            && let Ok(entries) = fs::read_dir(base)
        {
            for entry in entries.flatten().take(2000) {
                let name = entry.file_name().to_string_lossy().to_string();
                if !name.starts_with(partial)
                    || matches!(name.as_str(), ".git" | ".reviewbox" | "node_modules")
                {
                    continue;
                }
                let directory = entry.file_type()?.is_dir();
                let label = if directory { format!("{name}/") } else { name };
                values.insert(
                    label.clone(),
                    EditorPathSuggestion {
                        label,
                        directory,
                        package: false,
                    },
                );
            }
        }
    }
    Ok(values.into_values().take(300).collect())
}
#[tauri::command]
pub async fn complete_editor_paths(
    storage: tauri::State<'_, Storage>,
    repository_id: String,
    path: String,
    prefix: String,
    packages: bool,
) -> AppResult<Vec<EditorPathSuggestion>> {
    if !super::enabled(
        &storage,
        if packages {
            EditorExtensionId::NpmIntellisense
        } else {
            EditorExtensionId::PathIntellisense
        },
    )? {
        return Ok(vec![]);
    }
    let root = crate::repositories::root(&storage, &repository_id)?;
    tauri::async_runtime::spawn_blocking(move || suggestions(&root, &path, &prefix, packages))
        .await
        .map_err(|_| AppError::new("paths", "Path suggestions failed."))?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounds_and_nearest_packages() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        fs::create_dir(root.join("src")).unwrap();
        fs::write(root.join("src/Widget.tsx"), "").unwrap();
        fs::write(
            root.join("package.json"),
            r#"{"dependencies":{"react":"*","@scope/ui":"*"}}"#,
        )
        .unwrap();
        assert_eq!(
            suggestions(&root, "src/main.ts", "./Wi", false).unwrap()[0].label,
            "Widget.tsx"
        );
        assert_eq!(
            suggestions(&root, "src/main.ts", "@scope", true).unwrap()[0].label,
            "@scope/ui"
        );
        assert!(
            suggestions(&root, "src/main.ts", "../../../", false)
                .unwrap()
                .is_empty()
        );
    }
}
