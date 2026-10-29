//! Explicit project bootstrap. Reading project data never imports agent instructions.
use crate::{
    contracts::*,
    project_storage::{self, Project},
    repositories,
    storage::Storage,
};
use std::{fs, io::Write, path::Path};

const KIND: &str = "project_skill_preferences";
const NAMES: &[&str] = &[
    "reviewbox-project",
    "reviewbox-review",
    "reviewbox-comments",
    "reviewbox-changes",
];
const START: &str = "<!-- REVIEWBOX_SKILLS_START -->";
const END: &str = "<!-- REVIEWBOX_SKILLS_END -->";

pub(crate) fn preferences(storage: &Storage) -> AppResult<ProjectSkillPreferences> {
    match storage.get(KIND, "preferences") {
        Ok(value) => Ok(value),
        Err(error) if error.code == "not_found" => Ok(ProjectSkillPreferences::default()),
        Err(error) => Err(error),
    }
}

fn configure(
    storage: &Storage,
    mut value: ProjectSkillPreferences,
) -> AppResult<ProjectSkillPreferences> {
    // A checkout override never enables imports while the global switch is off.
    if value.projects.len() > 10_000 || value.projects.keys().any(|id| id.len() > 160) {
        return Err(AppError::new(
            "invalid_settings",
            "Too many project preferences.",
        ));
    }
    match storage.get::<ProjectSkillPreferences>(KIND, "preferences") {
        Ok(_) => {
            let revision = value.revision;
            value.revision += 1;
            storage.replace(KIND, "preferences", revision, &value)?;
        }
        Err(error) if error.code == "not_found" => {
            value.revision = 0;
            storage.insert(KIND, "preferences", &value)?;
        }
        Err(error) => return Err(error),
    }
    Ok(value)
}

fn create_missing(root: &Path, relative: &str, content: &[u8]) -> AppResult<bool> {
    let path = project_storage::checked(root, relative)?;
    if path.exists() {
        return Ok(false);
    }
    let parent = path
        .parent()
        .ok_or_else(|| AppError::new("path", "Missing parent."))?;
    fs::create_dir_all(parent)?;
    // Re-check after creating parents, and never replace a file created by another writer.
    let path = project_storage::checked(root, relative)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(content)?;
    temporary.as_file().sync_all()?;
    match temporary.persist_noclobber(&path) {
        Ok(_) => Ok(true),
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(error.error.into()),
    }
}

fn install(root: &Path, resources: &Path, report: &mut ProjectSkillImport) -> AppResult<()> {
    for name in NAMES {
        let relative = format!(".agents/skills/{name}/SKILL.md");
        // Do not read the bundled replacement unless this destination is actually absent.
        let exists = project_storage::checked(root, &relative)?.exists();
        if exists {
            report.preserved.push(relative);
        } else if create_missing(
            root,
            &relative,
            &fs::read(resources.join("project-skills").join(name).join("SKILL.md"))?,
        )? {
            report.created.push(relative);
        } else {
            report.preserved.push(relative);
        }
    }
    let path = project_storage::checked(root, "AGENTS.md")?;
    let previous = if path.exists() {
        if fs::metadata(&path)?.len() > 2 * 1024 * 1024 {
            return Err(AppError::new(
                "large_file",
                "AGENTS.md exceeds the 2 MiB limit.",
            ));
        }
        fs::read(&path)?
    } else {
        Vec::new()
    };
    let text = std::str::from_utf8(&previous).map_err(|_| {
        AppError::new(
            "encoding",
            "AGENTS.md must be UTF-8; it was left unchanged.",
        )
    })?;
    if text.contains(START) || text.contains(END) {
        report.preserved.push("AGENTS.md".into());
        return Ok(());
    }
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut content = text.to_owned();
    if !content.is_empty() && !content.ends_with('\n') {
        content.push_str(newline);
    }
    content.push_str(newline);
    content.push_str(START);
    content.push_str(newline);
    content.push_str("## ReviewBox project skills");
    content.push_str(newline);
    for name in NAMES {
        content.push_str(&format!(
            "- [{name}](.agents/skills/{name}/SKILL.md){newline}"
        ));
    }
    content.push_str(END);
    content.push_str(newline);
    if previous.is_empty() && !path.exists() {
        if !create_missing(root, "AGENTS.md", content.as_bytes())? {
            return Err(AppError::new(
                "conflict",
                "AGENTS.md appeared during import; retry without overwriting it.",
            ));
        }
    } else {
        let path = project_storage::checked(root, "AGENTS.md")?;
        if fs::read(&path)? != previous {
            return Err(AppError::new(
                "conflict",
                "AGENTS.md changed during import; retry.",
            ));
        }
        let permissions = fs::metadata(&path)?.permissions();
        project_storage::atomic(&path, content.as_bytes())?;
        fs::set_permissions(&path, permissions)?;
    }
    report
        .created
        .push("AGENTS.md (references appended)".into());
    Ok(())
}

pub(crate) fn bootstrap(
    storage: &Storage,
    repository: &Repository,
    resources: &Path,
) -> AppResult<ProjectSkillImport> {
    let settings = preferences(storage)?;
    let enabled = settings.enabled
        && settings
            .projects
            .get(&repository.id)
            .copied()
            .unwrap_or(true);
    let mut report = ProjectSkillImport {
        repository_id: repository.id.clone(),
        enabled,
        created: vec![],
        preserved: vec![],
        error: None,
    };
    if enabled {
        let root = repositories::root(storage, &repository.id)?;
        let project = Project::open(&root, &repository.id)?;
        let _lock = project.lock()?;
        if let Err(error) = install(&root, resources, &mut report) {
            report.error = Some(error);
        }
    }
    Ok(report)
}

/// Resolve resources for the standalone CLI without embedding prompt text in Rust.
pub(crate) fn cli_resources() -> AppResult<std::path::PathBuf> {
    if cfg!(debug_assertions) {
        return Ok(Path::new(env!("CARGO_MANIFEST_DIR")).join("../resources/agents"));
    }
    let exe = std::env::current_exe()?;
    let parent = exe
        .parent()
        .ok_or_else(|| AppError::new("resources", "Missing executable directory."))?;
    let candidates = [
        parent.join("../Resources/agents"),
        parent.join("agents"),
        parent.join("../share/reviewbox/agents"),
    ];
    candidates
        .into_iter()
        .find(|path| path.join("project-skills").is_dir())
        .ok_or_else(|| {
            AppError::new(
                "resources",
                "The bundled ReviewBox skills could not be located.",
            )
        })
}

#[tauri::command]
pub fn project_skill_preferences(
    storage: tauri::State<'_, Storage>,
) -> AppResult<ProjectSkillPreferences> {
    preferences(&storage)
}

#[tauri::command]
pub fn configure_project_skills(
    storage: tauri::State<'_, Storage>,
    preferences: ProjectSkillPreferences,
) -> AppResult<ProjectSkillPreferences> {
    configure(&storage, preferences)
}

#[tauri::command]
pub async fn import_project_skills(
    app: tauri::AppHandle,
    storage: tauri::State<'_, Storage>,
    repository_id: String,
) -> AppResult<ProjectSkillImport> {
    let resources = crate::commands::resource_root(&app)?;
    let storage = storage.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let repository = storage.get("repository", &repository_id)?;
        bootstrap(&storage, &repository, &resources)
    })
    .await
    .map_err(|e| AppError::new("task_failed", e.to_string()))?
}

#[cfg(test)]
mod tests;
