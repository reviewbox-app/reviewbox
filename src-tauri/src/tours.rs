use crate::{contracts::*, reviews, storage::Storage};
use serde::{Deserialize, Serialize};
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Tour {
    format: String,
    version: u32,
    title: String,
    topics: Vec<PortableTopic>,
}
#[derive(Serialize, Deserialize)]
struct PortableTopic {
    title: String,
    brief: String,
    steps: Vec<PortableStep>,
}
#[derive(Serialize, Deserialize)]
struct PortableStep {
    title: String,
    description: String,
    anchors: Vec<PortableAnchor>,
}
#[derive(Serialize, Deserialize)]
struct PortableAnchor {
    file: String,
    layer: String,
    fingerprint: String,
}
pub fn export(storage: &Storage, id: &str) -> AppResult<String> {
    let w = reviews::load(storage, id)?;
    let topics = w
        .review
        .topics
        .iter()
        .map(|topic| {
            Ok(PortableTopic {
                title: topic.title.clone(),
                brief: topic.brief.clone(),
                steps: topic
                    .steps
                    .iter()
                    .map(|step| {
                        Ok(PortableStep {
                            title: step.title.clone(),
                            description: step.explanation.clone(),
                            anchors: step
                                .anchors
                                .iter()
                                .map(|anchor| {
                                    let p = reviews::passage(&w.snapshot, anchor)?;
                                    let c = w
                                        .snapshot
                                        .changes
                                        .iter()
                                        .find(|c| c.id == anchor.change_id)
                                        .ok_or_else(|| {
                                            AppError::new(
                                                "invalid_anchor",
                                                "Cannot export a stale anchor.",
                                            )
                                        })?;
                                    Ok(PortableAnchor {
                                        file: c.path.clone(),
                                        layer: c.layer.clone(),
                                        fingerprint: p.fingerprint.clone(),
                                    })
                                })
                                .collect::<AppResult<_>>()?,
                        })
                    })
                    .collect::<AppResult<_>>()?,
            })
        })
        .collect::<AppResult<_>>()?;
    Ok(serde_json::to_string_pretty(&Tour {
        format: "reviewbox-tour".into(),
        version: 1,
        title: w.review.title,
        topics,
    })?)
}
pub fn import(storage: &Storage, id: &str, revision: u32, text: &str) -> AppResult<Workspace> {
    if text.len() > 4 * 1024 * 1024 {
        return Err(AppError::new("large_import", "Tour exceeds 4 MiB."));
    }
    let w = reviews::load(storage, id)?;
    let tour: Tour = serde_json::from_str(text)?;
    if tour.format != "reviewbox-tour" || tour.version != 1 {
        return Err(AppError::new(
            "unsupported_format",
            "Expected reviewbox-tour version 1.",
        ));
    }
    let mut topics = w.review.topics;
    for topic in tour.topics {
        let mut steps = vec![];
        for step in topic.steps {
            let mut anchors = vec![];
            for anchor in step.anchors {
                crate::snapshots::safe_path(&anchor.file)?;
                let matches: Vec<_> = w
                    .snapshot
                    .changes
                    .iter()
                    .filter(|c| c.path == anchor.file && c.layer == anchor.layer)
                    .flat_map(|c| {
                        c.passages
                            .iter()
                            .filter(|p| p.fingerprint == anchor.fingerprint)
                            .map(move |p| (c, p))
                    })
                    .collect();
                if matches.len() != 1 {
                    return Err(AppError::new(
                        "incompatible_tour",
                        format!(
                            "{} has a missing or ambiguous anchor. No steps were imported.",
                            anchor.file
                        ),
                    ));
                }
                anchors.push(CodeAnchor {
                    snapshot_id: w.snapshot.id.clone(),
                    change_id: matches[0].0.id.clone(),
                    passage_id: matches[0].1.id.clone(),
                });
            }
            steps.push(Step {
                id: crate::contracts::id(),
                title: step.title,
                explanation: step.description,
                anchors,
            });
        }
        topics.push(Topic {
            id: crate::contracts::id(),
            title: topic.title,
            brief: topic.brief,
            steps,
        });
    }
    reviews::apply(storage, id, revision, ReviewAction::SaveTopics { topics })
}
