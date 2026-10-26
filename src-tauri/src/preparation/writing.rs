//! Private generation preferences, independent of shared project settings.
use super::*;

const SETTINGS: &str = "review_writing";
#[derive(Clone, Serialize, Deserialize)]
struct SavedProfile {
    revision: u32,
    profile: Option<ReviewWritingProfile>,
}
pub(crate) fn load(
    storage: &Storage,
    repository: Option<&str>,
) -> AppResult<Option<ReviewWritingProfile>> {
    match storage.local_get::<SavedProfile>(SETTINGS, repository.unwrap_or("global")) {
        Ok(saved) => Ok(saved.profile),
        Err(error) if error.code == "not_found" => Ok(None),
        Err(error) => Err(error),
    }
}
pub(super) fn effective(storage: &Storage, repository: &str) -> AppResult<ReviewWritingProfile> {
    Ok(load(storage, Some(repository))?
        .or(load(storage, None)?)
        .unwrap_or_default())
}
pub(crate) fn store(
    storage: &Storage,
    repository: Option<&str>,
    profile: Option<ReviewWritingProfile>,
) -> AppResult<()> {
    if let Some(profile) = &profile
        && profile.style == ReviewWritingStyle::Custom
        && profile.instructions.trim().is_empty()
    {
        return Err(AppError::new(
            "writing_profile",
            "Custom needs writing instructions.",
        ));
    }
    let key = repository.unwrap_or("global");
    match storage.local_get::<SavedProfile>(SETTINGS, key) {
        Ok(previous) => storage.replace(
            SETTINGS,
            key,
            previous.revision,
            &SavedProfile {
                revision: previous.revision + 1,
                profile,
            },
        ),
        Err(error) if error.code == "not_found" => storage.insert(
            SETTINGS,
            key,
            &SavedProfile {
                revision: 0,
                profile,
            },
        ),
        Err(error) => Err(error),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn private_project_override_inherits_without_mutating_shared_settings() {
        let (_dir, storage, workspace) = crate::preparation::tests::native::fixture();
        let repo = &workspace.review.repository_id;
        let before = serde_json::to_value(storage.project_settings(repo).unwrap()).unwrap();
        assert_eq!(
            effective(&storage, repo).unwrap().style,
            ReviewWritingStyle::Essential
        );
        let technical = ReviewWritingProfile {
            style: ReviewWritingStyle::Technical,
            instructions: String::new(),
        };
        store(&storage, None, Some(technical.clone())).unwrap();
        assert_eq!(effective(&storage, repo).unwrap(), technical);
        let custom = ReviewWritingProfile {
            style: ReviewWritingStyle::Custom,
            instructions: "Explain user-visible consequences.".into(),
        };
        store(&storage, Some(repo), Some(custom.clone())).unwrap();
        assert_eq!(effective(&storage, repo).unwrap(), custom);
        store(&storage, Some(repo), None).unwrap();
        assert_eq!(effective(&storage, repo).unwrap(), technical);
        assert_eq!(
            serde_json::to_value(storage.project_settings(repo).unwrap()).unwrap(),
            before
        );
        assert!(
            store(
                &storage,
                None,
                Some(ReviewWritingProfile {
                    style: ReviewWritingStyle::Custom,
                    instructions: String::new()
                })
            )
            .is_err()
        );
    }
}
