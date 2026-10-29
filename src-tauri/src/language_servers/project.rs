//! Local language configuration and bounded project-root discovery.
use super::{catalog, packs};
use crate::{contracts::*, storage::Storage};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};
use tauri::State;

pub(super) struct Project {
    pub root: PathBuf,
    pub scope: PathBuf,
    pub settings: Value,
    pub initialization_options: Value,
    pub watched_files: Vec<String>,
    pub configuration_paths: Vec<String>,
    pub context: LiveLanguageProjectContext,
}
fn key(root: &Path, server: &str) -> String {
    fingerprint(format!("{}/{server}", root.display()).as_bytes())
}
fn scoped_key(root: &Path, server: &str, scope: Option<&Path>) -> String {
    if let Some(scope) = scope.filter(|p| *p != root) {
        fingerprint(format!("{}/{server}/{}", root.display(), scope.display()).as_bytes())
    } else {
        key(root, server)
    }
}
pub(super) fn settings(
    storage: &Storage,
    root: &Path,
    server: &str,
    scope: Option<&Path>,
) -> AppResult<LiveLanguageProjectSettings> {
    let id = scoped_key(root, server, scope);
    match storage.get("language_project", &id) {
        Ok(value) => Ok(value),
        Err(e) if e.code == "not_found" && id != key(root, server) => {
            settings(storage, root, server, None)
        }
        Err(e) if e.code == "not_found" => Ok(LiveLanguageProjectSettings {
            settings: json!({}),
            ..Default::default()
        }),
        Err(e) => Err(e),
    }
}
#[tauri::command]
pub fn get_live_language_project_settings(
    storage: State<'_, Storage>,
    repository_id: String,
    server_id: String,
    path: Option<String>,
) -> AppResult<LiveLanguageProjectSettings> {
    let root = crate::repositories::root(&storage, &repository_id)?;
    let scope = path
        .as_deref()
        .map(|path| resolve_inner(&storage, &root, path, &server_id, false).map(|p| p.scope))
        .transpose()?;
    settings(&storage, &root, &server_id, scope.as_deref())
}
#[tauri::command]
pub fn set_live_language_project_settings(
    storage: State<'_, Storage>,
    live: State<'_, super::live::LiveLanguages>,
    repository_id: String,
    server_id: String,
    path: Option<String>,
    mut settings: LiveLanguageProjectSettings,
) -> AppResult<LiveLanguageProjectSettings> {
    let root = crate::repositories::root(&storage, &repository_id)?;
    if !catalog::valid_id(&server_id)
        || !settings.settings.is_object()
        || settings
            .initialization_options
            .as_ref()
            .is_some_and(|v| !v.is_object())
        || serde_json::to_vec(&settings)?.len() > 256 * 1024
    {
        return Err(AppError::new(
            "invalid_language_configuration",
            "Provide bounded language settings objects.",
        ));
    }
    if let Some(relative) = &settings.root {
        override_root(&root, relative)?;
    }
    if settings
        .environment
        .iter()
        .any(|(k, v)| k.is_empty() || k.contains(['=', '\0']) || v.contains('\0'))
    {
        return Err(AppError::new(
            "invalid_language_configuration",
            "Invalid environment variable.",
        ));
    }
    let scope = path
        .as_deref()
        .map(|path| resolve_inner(&storage, &root, path, &server_id, false).map(|p| p.scope))
        .transpose()?;
    let id = scoped_key(&root, &server_id, scope.as_deref());
    match storage.get::<LiveLanguageProjectSettings>("language_project", &id) {
        Ok(_) => {
            let revision = settings.revision;
            settings.revision += 1;
            storage.replace("language_project", &id, revision, &settings)?;
        }
        Err(e) if e.code == "not_found" => {
            settings.revision = 0;
            storage.insert("language_project", &id, &settings)?;
        }
        Err(e) => return Err(e),
    }
    live.invalidate_project(&root, &server_id, scope.as_deref());
    Ok(settings)
}
fn override_root(root: &Path, relative: &str) -> AppResult<PathBuf> {
    let path = if relative.is_empty() || relative == "." {
        root.to_path_buf()
    } else {
        crate::editor::path(root, relative)?
    };
    let canonical = path.canonicalize()?;
    if !canonical.starts_with(root) || !canonical.is_dir() {
        return Err(AppError::new(
            "invalid_project_root",
            "The project root must be a folder inside this checkout.",
        ));
    }
    Ok(canonical)
}
fn read_configuration(path: &Path) -> Option<Vec<u8>> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > 2 * 1024 * 1024 {
        return None;
    }
    fs::read(path).ok()
}
fn configuration_fingerprint(path: &Path) -> Option<String> {
    if let Some(content) = read_configuration(path) {
        return Some(fingerprint(&content));
    }
    // Monorepo lockfiles can exceed the bounded configuration reader. Track
    // their metadata rather than silently retaining sessions after an install.
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    Some(fingerprint(
        format!("{}:{:?}", metadata.len(), metadata.modified().ok()).as_bytes(),
    ))
}
pub(super) fn uses_vue(checkout: &Path, path: &str) -> bool {
    let Ok(file) = crate::editor::path(checkout, path) else {
        return false;
    };
    file.ancestors()
        .skip(1)
        .take_while(|p| p.starts_with(checkout))
        .any(|directory| {
            read_configuration(&directory.join("package.json"))
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                .is_some_and(|package| {
                    ["dependencies", "devDependencies", "peerDependencies"]
                        .iter()
                        .any(|section| {
                            ["vue", "nuxt", "@vue/runtime-dom"]
                                .iter()
                                .any(|name| package[section].get(name).is_some())
                        })
                })
        })
}
fn cargo_workspace(path: &Path) -> bool {
    read_configuration(&path.join("Cargo.toml"))
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .and_then(|text| toml::from_str::<toml::Value>(&text).ok())
        .is_some_and(|value| value.get("workspace").is_some())
}
fn merge(target: &mut Value, patch: &Value) {
    if patch.is_object() && !target.is_object() {
        *target = json!({});
    }
    if let (Some(target), Some(patch)) = (target.as_object_mut(), patch.as_object()) {
        for (key, value) in patch {
            if value.is_object() {
                merge(target.entry(key).or_insert_with(|| json!({})), value);
            } else {
                target.insert(key.clone(), value.clone());
            }
        }
    }
}
pub(super) fn resolve(
    storage: &Storage,
    checkout: &Path,
    path: &str,
    server: &str,
) -> AppResult<Project> {
    resolve_inner(storage, checkout, path, server, true)
}
fn resolve_inner(
    storage: &Storage,
    checkout: &Path,
    path: &str,
    server: &str,
    apply_root_override: bool,
) -> AppResult<Project> {
    let pack = packs::all(storage)?.into_iter().find(|p| p.id == server);
    let bundled: BTreeMap<String, Vec<String>> = serde_json::from_str(include_str!(
        "../../../resources/languages/project-roots.json"
    ))?;
    let markers = pack
        .as_ref()
        .map(|p| p.root_markers.clone())
        .or_else(|| bundled.get(server).cloned())
        .unwrap_or_default();
    let file = crate::editor::path(checkout, path)?;
    let ancestors = file
        .ancestors()
        .skip(1)
        .take_while(|p| p.starts_with(checkout))
        .collect::<Vec<_>>();
    let nearest = ancestors
        .iter()
        .find(|p| markers.iter().any(|m| p.join(m).is_file()))
        .copied()
        .unwrap_or(checkout);
    let strategy = pack
        .as_ref()
        .and_then(|p| p.root_strategy)
        .unwrap_or_default();
    let discovered = if server == "rust" {
        ancestors
            .iter()
            .find(|p| cargo_workspace(p))
            .copied()
            .unwrap_or(nearest)
    } else if server == "go" {
        ancestors
            .iter()
            .find(|p| p.join("go.work").is_file())
            .copied()
            .unwrap_or(nearest)
    } else if matches!(strategy, LanguageRootStrategy::Workspace) {
        ancestors
            .iter()
            .rev()
            .find(|p| markers.iter().any(|m| p.join(m).is_file()))
            .copied()
            .unwrap_or(nearest)
    } else {
        nearest
    };
    let local = settings(storage, checkout, server, Some(discovered))?;
    let root = local
        .root
        .as_ref()
        .filter(|_| apply_root_override)
        .map(|r| override_root(checkout, r))
        .transpose()?
        .unwrap_or_else(|| discovered.to_path_buf());
    let server_config = pack.as_ref().and_then(|p| p.server.as_ref());
    let mut settings = server_config
        .map(|s| s.settings.clone())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    if server == "prisma" && settings["prisma"].is_null() {
        settings["prisma"] = json!({"enableDiagnostics":true});
    }
    merge(&mut settings, &local.settings);
    // Omitted initializationOptions retains the historical pack behavior.
    let mut environment = local.environment.clone();
    let mut missing = Vec::new();
    if server == "python" {
        let candidate = environment
            .get("VIRTUAL_ENV")
            .map(PathBuf::from)
            .into_iter()
            .chain([root.join(".venv"), root.join("venv")])
            .find(|p| p.join("pyvenv.cfg").is_file());
        if let Some(venv) = candidate {
            let python = if cfg!(windows) {
                venv.join("Scripts/python.exe")
            } else {
                venv.join("bin/python")
            };
            if python.is_file() && settings["python"]["pythonPath"].is_null() {
                merge(&mut settings, &json!({"python":{"pythonPath":python}}));
                environment
                    .entry("VIRTUAL_ENV".into())
                    .or_insert_with(|| venv.to_string_lossy().into_owned());
            }
        }
    }
    if server == "clangd" {
        let database = settings["compilationDatabasePath"]
            .as_str()
            .map(|path| PathBuf::from(path).join("compile_commands.json"))
            .into_iter()
            .chain([
                root.join("compile_commands.json"),
                root.join("build/compile_commands.json"),
            ])
            .find(|p| p.is_file());
        if let Some(database) = database.as_ref()
            && settings["compilationDatabasePath"].is_null()
        {
            merge(
                &mut settings,
                &json!({"compilationDatabasePath":database.parent()}),
            );
        } else if database.is_none() && !root.join(".clangd").is_file() {
            missing.push("No compile_commands.json or .clangd configuration was found.".into());
        }
    }
    let mut configuration_files = Vec::new();
    let mut configuration_paths = Vec::new();
    let mut versions = Vec::new();
    for directory in &ancestors {
        for marker in markers.iter().map(String::as_str).chain([
            "build/compile_commands.json",
            ".venv/pyvenv.cfg",
            "venv/pyvenv.cfg",
        ]) {
            let candidate = directory.join(marker);
            if let Ok(relative) = candidate.strip_prefix(checkout) {
                configuration_paths.push(relative.to_string_lossy().replace('\\', "/"));
            }
            if let Some(version) = configuration_fingerprint(&candidate)
                && let Ok(relative) = candidate.strip_prefix(checkout)
            {
                let relative = relative.to_string_lossy().replace('\\', "/");
                configuration_files.push(relative.clone());
                versions.push((relative, version));
            }
        }
    }
    configuration_files.sort();
    configuration_files.dedup();
    let mut initialization_options = local
        .initialization_options
        .clone()
        .or_else(|| server_config.and_then(|s| s.initialization_options.clone()))
        .unwrap_or_else(|| settings.clone());
    if matches!(server, "typescript" | "vue") {
        let private = catalog::installed(storage, server)?
            .and_then(|r| r.directory)
            .map(|p| p.join("node_modules/typescript/lib"));
        let sdk = ancestors
            .iter()
            .map(|p| p.join("node_modules/typescript/lib"))
            .find(|p| p.join("tsserver.js").is_file())
            .or(private);
        let mut defaults = json!({"hostInfo":"ReviewBox", "preferences":{"includeCompletionsForModuleExports":true,"includeCompletionsForImportStatements":true,"allowIncompleteCompletions":true}});
        if let Some(sdk) = sdk {
            defaults["tsserver"] = json!({"path":sdk.join("tsserver.js")});
            defaults["typescript"] = json!({"tsdk":sdk});
        }
        if server == "typescript"
            && crate::editor_extensions::enabled(storage, EditorExtensionId::Vue)?
            && let Some(modules) = catalog::installed(storage, "vue")?
                .and_then(|r| r.directory)
                .map(|p| p.join("node_modules"))
        {
            defaults["plugins"] = json!([{"name":"@vue/typescript-plugin","location":modules.join("@vue/typescript-plugin"),"languages":["vue"],"configNamespace":"typescript"}]);
        }
        merge(&mut defaults, &initialization_options);
        defaults["disableAutomaticTypingAcquisition"] = json!(true);
        initialization_options = defaults;
        for directory in &ancestors {
            for name in [
                "package.json",
                "bun.lock",
                "package-lock.json",
                "pnpm-lock.yaml",
                "yarn.lock",
                "node_modules/typescript/package.json",
            ] {
                let path = directory.join(name);
                if let Ok(relative) = path.strip_prefix(checkout) {
                    configuration_paths.push(relative.to_string_lossy().replace('\\', "/"));
                    if let Some(version) = configuration_fingerprint(&path) {
                        versions.push((relative.to_string_lossy().to_string(), version));
                    }
                }
            }
        }
    }
    let signature = fingerprint(&serde_json::to_vec(&(
        &root,
        &settings,
        &initialization_options,
        &environment,
        &versions,
        pack.as_ref().map(|p| &p.version),
        local.revision,
        server,
        catalog::spec(server).ok().map(|s| s.version),
    ))?);
    let root_uri = url::Url::from_directory_path(&root)
        .map_err(|_| AppError::new("invalid_project_root", "Invalid project URI."))?
        .to_string();
    let watched_files = pack.and_then(|p| p.watched_files).unwrap_or_else(|| {
        let mut patterns = markers
            .iter()
            .map(|m| format!("**/{m}"))
            .collect::<Vec<_>>();
        if let Ok(spec) = catalog::spec(server) {
            patterns.extend(spec.extensions.iter().map(|e| format!("**/*.{e}")));
        }
        patterns
    });
    Ok(Project {
        root,
        scope: discovered.to_path_buf(),
        settings,
        initialization_options,
        watched_files,
        configuration_paths,
        context: LiveLanguageProjectContext {
            root_uri,
            configuration_files,
            environment,
            missing,
            signature,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn large_dependency_lockfiles_invalidate_the_project_session() {
        let temp = tempfile::tempdir().unwrap();
        let storage = Storage::open(temp.path().join("private")).unwrap();
        let root = temp.path().join("repo");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("package.json"), "{}").unwrap();
        let file = fs::File::create(root.join("pnpm-lock.yaml")).unwrap();
        file.set_len(3 * 1024 * 1024).unwrap();
        let before = resolve(&storage, &root, "main.ts", "typescript").unwrap();
        file.set_len(3 * 1024 * 1024 + 1).unwrap();
        let after = resolve(&storage, &root, "main.ts", "typescript").unwrap();
        assert_ne!(before.context.signature, after.context.signature);
    }
    #[test]
    fn cargo_workspace_python_environment_and_clang_build_database_are_discovered() {
        let temp = tempfile::tempdir().unwrap();
        let storage = Storage::open(temp.path().join("private")).unwrap();
        let root = temp.path().join("repo");
        fs::create_dir_all(root.join("crates/a/src")).unwrap();
        fs::write(
            root.join("Cargo.toml"),
            "[workspace]\nmembers=[\"crates/a\"]\n",
        )
        .unwrap();
        fs::write(
            root.join("crates/a/Cargo.toml"),
            "[package]\nname=\"a\"\nversion=\"0.1.0\"\n",
        )
        .unwrap();
        let cargo = resolve(&storage, &root, "crates/a/src/lib.rs", "rust").unwrap();
        assert_eq!(cargo.root, root);
        assert!(
            cargo
                .context
                .configuration_files
                .contains(&"Cargo.toml".to_owned())
        );
        fs::create_dir_all(root.join("python/.venv/bin")).unwrap();
        fs::write(
            root.join("python/pyproject.toml"),
            "[project]\nname=\"python\"\n",
        )
        .unwrap();
        fs::write(root.join("python/.venv/pyvenv.cfg"), "home = /usr/bin\n").unwrap();
        fs::write(root.join("python/.venv/bin/python"), "").unwrap();
        let python = resolve(&storage, &root, "python/main.py", "python").unwrap();
        assert!(
            python.settings["python"]["pythonPath"]
                .as_str()
                .unwrap()
                .ends_with(".venv/bin/python")
        );
        fs::create_dir_all(root.join("cpp/build")).unwrap();
        fs::write(root.join("cpp/CMakeLists.txt"), "project(test)").unwrap();
        let before = resolve(&storage, &root, "cpp/main.cpp", "clangd").unwrap();
        assert!(!before.context.missing.is_empty());
        fs::write(root.join("cpp/build/compile_commands.json"), "[]").unwrap();
        let after = resolve(&storage, &root, "cpp/main.cpp", "clangd").unwrap();
        assert_ne!(before.context.signature, after.context.signature);
        assert!(after.context.missing.is_empty());
        assert!(
            after.initialization_options["compilationDatabasePath"]
                .as_str()
                .unwrap()
                .ends_with("cpp/build")
        );
    }
    #[test]
    fn local_overrides_are_private_versioned_and_bounded_by_checkout() {
        let temp = tempfile::tempdir().unwrap();
        let storage = Storage::open(temp.path().join("private")).unwrap();
        let root = temp.path().join("repo");
        fs::create_dir_all(root.join("packages/a/src")).unwrap();
        let root = root.canonicalize().unwrap();
        fs::write(root.join("package.json"), "{}").unwrap();
        fs::write(root.join("packages/a/package.json"), "{}").unwrap();
        let defaults = resolve(&storage, &root, "packages/a/src/main.ts", "typescript").unwrap();
        assert_eq!(defaults.root, root.join("packages/a"));
        storage
            .insert(
                "language_project",
                &key(&root, "typescript"),
                &LiveLanguageProjectSettings {
                    root: Some(".".into()),
                    settings: json!({"typescript":{"preferences":{"quotePreference":"single"}}}),
                    initialization_options: Some(json!({"hostInfo":"ReviewBox"})),
                    ..Default::default()
                },
            )
            .unwrap();
        let overrides = resolve(&storage, &root, "packages/a/src/main.ts", "typescript").unwrap();
        assert_eq!(overrides.root, root);
        assert_eq!(overrides.initialization_options["hostInfo"], "ReviewBox");
        assert_ne!(overrides.context.signature, defaults.context.signature);
        assert!(!root.join(".reviewbox").exists());
        assert!(override_root(&root, "../outside").is_err());
        fs::create_dir_all(root.join("packages/b/src")).unwrap();
        fs::write(root.join("packages/b/package.json"), "{}").unwrap();
        storage
            .insert(
                "language_project",
                &scoped_key(&root, "typescript", Some(&root.join("packages/a"))),
                &LiveLanguageProjectSettings {
                    settings: json!({"typescript":{"preferences":{"quotePreference":"double"}}}),
                    ..Default::default()
                },
            )
            .unwrap();
        let a = resolve(&storage, &root, "packages/a/src/main.ts", "typescript").unwrap();
        let b = resolve(&storage, &root, "packages/b/src/main.ts", "typescript").unwrap();
        assert_eq!(
            a.settings["typescript"]["preferences"]["quotePreference"],
            "double"
        );
        assert_eq!(
            b.settings["typescript"]["preferences"]["quotePreference"],
            "single"
        );
        assert_eq!(a.root, root.join("packages/a"));
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(temp.path(), root.join("escape")).unwrap();
            assert!(override_root(&root, "escape").is_err());
        }
    }
}
