//! Conversation continuity belongs to ReviewBox, independently of harness sessions.
use super::*;
use serde_json::json;
use std::{fs, path::Path};

fn history(storage: &Storage, request: &AgentRequest) -> AppResult<Vec<AgentRun>> {
    let candidates = if let Some(context) = &request.context_id {
        knowledge::context::history(storage, context)?
    } else {
        storage.list::<AgentRun>("agent_run")?
    };
    let mut runs: Vec<AgentRun> = candidates
        .into_iter()
        .filter(|run| {
            run.review_id == request.review_id
                && (request.context_id.is_some() || run.context_id.is_none())
                && run.id != request.id
                && run.status != "running"
        })
        .collect();
    runs.sort_by(|left, right| (&left.created_at, &left.id).cmp(&(&right.created_at, &right.id)));
    Ok(runs)
}

fn path(directory: &Path, run: &AgentRun) -> PathBuf {
    directory
        .join("conversation")
        .join(format!("{}.json", fingerprint(run.id.as_bytes())))
}

fn entry(directory: &Path, run: &AgentRun) -> Value {
    json!({
        "runId": run.id,
        "snapshotId": run.snapshot_id,
        "provider": run.provider,
        "action": run.action,
        "status": run.status,
        "createdAt": run.created_at,
        "paths": run.paths,
        "exchangeFile": path(directory, run),
    })
}

fn excerpt(text: &str, limit: usize) -> Value {
    json!({"text":text.chars().take(limit).collect::<String>(), "truncated":text.chars().count() > limit})
}

pub(super) fn descriptor(
    storage: &Storage,
    request: &AgentRequest,
    directory: &Path,
) -> AppResult<Value> {
    let runs = history(storage, request)?;
    // This is a bounded entry point, not a history limit. Complete exchanges
    // remain available on demand, without recursively copying previous prompts.
    let recent: Vec<_> = runs
        .iter()
        .skip(runs.len().saturating_sub(3))
        .map(|run| {
            let mut value = entry(directory, run);
            value["requestExcerpt"] = run
                .request
                .as_deref()
                .map(|text| excerpt(text, 600))
                .unwrap_or(Value::Null);
            value["answerExcerpt"] = excerpt(&run.output, 1200);
            value
        })
        .collect();
    Ok(json!({
        "historyIndex": directory.join("conversation.json"),
        "exchangeCount": runs.len(),
        "recentExchanges": recent,
    }))
}

pub(super) fn materialize(
    storage: &Storage,
    request: &AgentRequest,
    directory: &Path,
    cancel: &AtomicBool,
) -> AppResult<()> {
    fs::create_dir(directory.join("conversation"))?;
    let mut index = Vec::new();
    for run in history(storage, request)? {
        if cancel.load(Ordering::Relaxed) {
            return Err(AppError::new("cancelled", "Agent request stopped."));
        }
        index.push(entry(directory, &run));
        let mut exchange = entry(directory, &run);
        exchange["request"] = serde_json::to_value(&run.request)?;
        exchange["answer"] = Value::String(run.output.clone());
        // Preserve access to the original question for legacy runs, whose
        // standalone request was not saved. Never parse it out heuristically.
        if run.request.is_none() {
            exchange["legacyPrompt"] = Value::String(run.prompt.text.clone());
        }
        fs::write(path(directory, &run), serde_json::to_vec_pretty(&exchange)?)?;
    }
    fs::write(
        directory.join("conversation.json"),
        serde_json::to_vec_pretty(&json!({
            "reviewId": request.review_id,
            "exchanges": index,
        }))?,
    )?;
    Ok(())
}
