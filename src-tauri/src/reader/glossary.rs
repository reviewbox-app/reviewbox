//! Review-scoped definitions. Arrival order never decides the published meaning.
use crate::contracts::*;
use std::collections::BTreeMap;

fn normalized(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}
fn identity(term: &DocumentTerm) -> String {
    format!("{}\n{}", normalized(&term.term), normalized(&term.context))
}

pub(crate) fn inherit(documents: &mut LevelDocuments, known: &[DocumentTerm]) {
    for term in known {
        if !documents.glossary.iter().any(|entry| entry.id == term.id)
            && [
                &documents.essential,
                &documents.explained,
                &documents.technical,
            ]
            .iter()
            .any(|doc| doc.body.contains(&format!("reviewbox:term/{}", term.id)))
        {
            documents.glossary.push(term.clone());
        }
    }
}

/// Traverse in reading order, canonicalize equivalent definitions and rewrite only
/// explicit glossary destinations. Different contextual meanings keep different IDs.
pub(crate) fn assemble(topics: &mut [Topic], existing: &[DocumentTerm]) -> Vec<DocumentTerm> {
    let mut catalogue = BTreeMap::<String, DocumentTerm>::new();
    for topic in topics {
        for step in &mut topic.steps {
            let shared = &step.documents.glossary;
            for document in [
                &mut step.documents.essential,
                &mut step.documents.explained,
                &mut step.documents.technical,
            ] {
                let mut definitions = existing.to_vec();
                for term in shared.iter().chain(&document.terms) {
                    definitions.retain(|entry| entry.id != term.id);
                    definitions.push(term.clone());
                }
                let mut replacements = BTreeMap::new();
                for term in definitions {
                    let key = identity(&term);
                    let canonical = catalogue
                        .entry(key.clone())
                        .or_insert_with(|| DocumentTerm {
                            id: format!("term-{}", fingerprint(key.as_bytes())),
                            ..term.clone()
                        });
                    replacements.insert(term.id, canonical.id.clone());
                }
                // One pass avoids changing a newly produced identifier twice.
                let body = &document.body;
                let mut output = String::new();
                let mut parts = body.split("reviewbox:term/");
                output.push_str(parts.next().unwrap_or_default());
                for part in parts {
                    output.push_str("reviewbox:term/");
                    let end = part
                        .find(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_')
                        .unwrap_or(part.len());
                    output.push_str(
                        replacements
                            .get(&part[..end])
                            .map(String::as_str)
                            .unwrap_or(&part[..end]),
                    );
                    output.push_str(&part[end..]);
                }
                for (alias, previous) in &mut document.term_aliases {
                    let _ = alias;
                    if let Some(canonical) = replacements.get(previous) {
                        *previous = canonical.clone();
                    }
                }
                document
                    .term_aliases
                    .extend(replacements.into_iter().filter(|(old, new)| old != new));
                document.body = output;
                document.terms.clear();
            }
            step.documents.glossary.clear();
        }
    }
    catalogue.into_values().collect()
}

/// Checkpoints stay self-contained while shared IDs can be reused by later jobs.
pub(crate) fn canonicalize(documents: LevelDocuments) -> LevelDocuments {
    let mut topics = vec![Topic {
        id: String::new(),
        title: String::new(),
        brief: String::new(),
        steps: vec![Step {
            id: String::new(),
            title: String::new(),
            anchors: vec![],
            documents,
        }],
    }];
    let glossary = assemble(&mut topics, &[]);
    let mut documents = topics.remove(0).steps.remove(0).documents;
    documents.glossary = glossary;
    documents
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn definitions_are_shared_but_different_meanings_remain_distinct() {
        let term = |id: &str, context: &str| DocumentTerm {
            id: id.into(),
            term: "State".into(),
            definition: "Current value".into(),
            context: context.into(),
        };
        let doc = |id: &str| ReviewDocument {
            body: format!("[State](reviewbox:term/{id})"),
            ..Default::default()
        };
        let first = canonicalize(LevelDocuments {
            dependencies: None,
            context_sources: vec![],
            glossary: vec![term("local", "Component")],
            essential: doc("local"),
            explained: doc("local"),
            technical: doc("local"),
        });
        assert_eq!(first.glossary.len(), 1);
        assert!(first.essential.terms.is_empty());
        assert!(first.essential.body.contains(&first.glossary[0].id));
        let equivalent = canonicalize(LevelDocuments {
            dependencies: None,
            context_sources: vec![],
            glossary: vec![term("another", "component")],
            essential: doc("another"),
            explained: doc("another"),
            technical: doc("another"),
        });
        assert_eq!(first.glossary[0].id, equivalent.glossary[0].id);
        let other = canonicalize(LevelDocuments {
            dependencies: None,
            context_sources: vec![],
            glossary: vec![term("another", "Workflow")],
            essential: doc("another"),
            explained: doc("another"),
            technical: doc("another"),
        });
        assert_ne!(first.glossary[0].id, other.glossary[0].id);
    }
}
