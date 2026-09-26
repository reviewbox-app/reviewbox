use crate::{contracts::*, repositories, snapshots, storage::Storage};
use serde_json::Value;
use std::path::Path;

pub fn current_file(storage: &Storage, repository_id: &str, path: &str) -> AppResult<String> {
    snapshots::safe_path(path)?;
    let root = repositories::root(storage, repository_id)?;
    let candidate = root.join(path);
    if !candidate.canonicalize()?.starts_with(&root)
        || candidate.symlink_metadata()?.file_type().is_symlink()
    {
        return Err(AppError::new(
            "external_path",
            "This file resolves outside the repository or is a symbolic link.",
        ));
    }
    if candidate.metadata()?.len() > 2 * 1024 * 1024 {
        return Err(AppError::new(
            "large_file",
            "Current-code preview is limited to 2 MiB.",
        ));
    }
    let text = std::fs::read_to_string(candidate)?;
    if text.contains('\0') {
        return Err(AppError::new(
            "binary",
            "Binary files do not have line anchors.",
        ));
    }
    Ok(text)
}
fn excerpt(text: &str, start: u32, end: u32) -> AppResult<String> {
    let lines: Vec<_> = text.split_inclusive('\n').collect();
    if start == 0 || end < start || end as usize > lines.len() {
        return Err(AppError::new(
            "invalid_anchor",
            "The line range is outside the current file.",
        ));
    }
    Ok(lines[start as usize - 1..end as usize].join(""))
}
pub fn save(storage: &Storage, mut tour: OnboardingTour) -> AppResult<OnboardingTour> {
    let _: Repository = storage.get("repository", &tour.repository_id)?;
    if tour.title.trim().is_empty() || tour.steps.len() > 256 {
        return Err(AppError::new(
            "invalid_tour",
            "Choose a title and at most 256 steps.",
        ));
    }
    let previous = match storage.get::<OnboardingTour>("onboarding", &tour.id) {
        Ok(t) => Some(t),
        Err(e) if e.code == "not_found" => None,
        Err(e) => return Err(e),
    };
    if previous
        .as_ref()
        .is_some_and(|p| p.repository_id != tour.repository_id || p.revision != tour.revision)
    {
        return Err(AppError::new(
            "conflict",
            "Reload this tour before changing it.",
        ));
    }
    let mut ids = std::collections::HashSet::new();
    for step in &mut tour.steps {
        if step.title.trim().is_empty() || !ids.insert(&step.id) {
            return Err(AppError::new(
                "invalid_step",
                "Steps need a title and distinct IDs.",
            ));
        }
        snapshots::safe_path(&step.path)?;
        // Empty quote means the user explicitly creates or repairs this line anchor.
        if step.quote.is_empty() {
            let text = current_file(storage, &tour.repository_id, &step.path)?;
            step.quote = excerpt(&text, step.start_line, step.end_line)?;
            step.fingerprint = fingerprint(step.quote.as_bytes());
        } else if previous.as_ref().is_none_or(|p| {
            !p.steps.iter().any(|s| {
                s.id == step.id
                    && s.path == step.path
                    && s.quote == step.quote
                    && s.fingerprint == step.fingerprint
                    && s.start_line == step.start_line
                    && s.end_line == step.end_line
            })
        }) {
            return Err(AppError::new(
                "invalid_anchor",
                "Repair edited anchors explicitly against the current file.",
            ));
        }
    }
    if let Some(previous) = &previous {
        let mut left = previous.clone();
        let mut right = tour.clone();
        for step in &mut left.steps {
            step.visited = false;
        }
        for step in &mut right.steps {
            step.visited = false;
        }
        if serde_json::to_value(left)? == serde_json::to_value(right)? {
            storage.save_visits(&tour)?;
            return Ok(tour);
        }
    }
    let revision = previous.map(|p| p.revision);
    tour.revision = revision.map_or(0, |r| r + 1);
    storage.write_batch(vec![(
        "onboarding",
        &tour.id,
        revision,
        serde_json::to_value(&tour)?,
    )])?;
    Ok(tour)
}
pub fn read_step(storage: &Storage, tour_id: &str, step_id: &str) -> AppResult<CurrentTourStep> {
    let tour: OnboardingTour = storage.get("onboarding", tour_id)?;
    let step = tour
        .steps
        .iter()
        .find(|s| s.id == step_id)
        .ok_or_else(|| AppError::new("not_found", "Step not found."))?;
    let text = current_file(storage, &tour.repository_id, &step.path)?;
    let exact = excerpt(&text, step.start_line, step.end_line)
        .is_ok_and(|q| fingerprint(q.as_bytes()) == step.fingerprint);
    let matches: Vec<_> = text
        .match_indices(&step.quote)
        .filter(|(index, _)| *index == 0 || text.as_bytes()[index - 1] == b'\n')
        .collect();
    let (status, start) = if exact {
        ("current", step.start_line)
    } else if matches.len() == 1 {
        (
            "relocated",
            text[..matches[0].0].bytes().filter(|b| *b == b'\n').count() as u32 + 1,
        )
    } else {
        ("stale", step.start_line)
    };
    Ok(CurrentTourStep {
        content: text,
        status: status.into(),
        start_line: start,
        end_line: start + step.end_line.saturating_sub(step.start_line),
    })
}
pub fn import(storage: &Storage, repository_id: &str, text: &str) -> AppResult<TourImportReport> {
    if text.len() > 4 * 1024 * 1024 {
        return Err(AppError::new("large_import", "Tour exceeds 4 MiB."));
    }
    let value: Value = serde_json::from_str(text)?;
    let title = value["title"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| AppError::new("invalid_tour", "Tour needs a title."))?;
    let steps = value["steps"]
        .as_array()
        .filter(|s| s.len() <= 256)
        .ok_or_else(|| AppError::new("invalid_tour", "Tour needs at most 256 steps."))?;
    let mut report = TourImportReport {
        tour: OnboardingTour {
            id: id(),
            repository_id: repository_id.into(),
            title: title.into(),
            steps: vec![],
            revision: 0,
        },
        warnings: vec![],
    };
    for key in value
        .as_object()
        .into_iter()
        .flat_map(|o| o.keys())
        .filter(|k| !["title", "steps", "format", "version"].contains(&k.as_str()))
    {
        report.warnings.push(format!(
            "Tour field '{key}' is ignored; anchors use current local code."
        ));
    }
    for (index, step) in steps.iter().enumerate() {
        let Some(path) = step["file"].as_str().or_else(|| step["path"].as_str()) else {
            report.warnings.push(format!(
                "Step {} skipped: a relative file is required.",
                index + 1
            ));
            continue;
        };
        if Path::new(path).is_absolute() || snapshots::safe_path(path).is_err() {
            report
                .warnings
                .push(format!("Step {} skipped: invalid file path.", index + 1));
            continue;
        }
        for key in step
            .as_object()
            .into_iter()
            .flat_map(|o| o.keys())
            .filter(|k| {
                ![
                    "file",
                    "path",
                    "line",
                    "startLine",
                    "endLine",
                    "selection",
                    "title",
                    "description",
                    "explanation",
                ]
                .contains(&k.as_str())
            })
        {
            report
                .warnings
                .push(format!("Step {}: '{key}' is ignored.", index + 1));
        }
        let start = step["selection"]["start"]["line"]
            .as_u64()
            .or_else(|| step["startLine"].as_u64())
            .or_else(|| step["line"].as_u64())
            .unwrap_or(1) as u32;
        let end = step["selection"]["end"]["line"]
            .as_u64()
            .or_else(|| step["endLine"].as_u64())
            .unwrap_or(start as u64) as u32;
        match current_file(storage, repository_id, path).and_then(|t| excerpt(&t, start, end)) {
            Ok(_) => report.tour.steps.push(OnboardingStep {
                id: id(),
                title: step["title"].as_str().unwrap_or(path).into(),
                explanation: step["description"]
                    .as_str()
                    .or_else(|| step["explanation"].as_str())
                    .unwrap_or("")
                    .into(),
                path: path.into(),
                start_line: start,
                end_line: end,
                quote: String::new(),
                fingerprint: String::new(),
                visited: false,
            }),
            Err(e) => report.warnings.push(format!(
                "Step {} ({path}) skipped: {}",
                index + 1,
                e.message
            )),
        }
    }
    // Preview only: saving needs the human's explicit acceptance in the import dialog.
    Ok(report)
}
