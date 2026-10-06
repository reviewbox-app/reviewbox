import type {
  Review,
  ReviewCompletion,
} from "@/lib/desktop/contracts.generated"

export function completionScopeLabel(completion: ReviewCompletion) {
  const short = (commit: string | null) => commit?.slice(0, 10)
  if (completion.scope === "commit")
    return `Commit ${short(completion.targetCommitId) ?? "unavailable"}`
  if (completion.scope === "range")
    return `Range ${short(completion.baseCommitId) ?? "unavailable"}…${short(completion.targetCommitId) ?? "unavailable"}`
  const label = {
    local: "Local changes",
    staged: "Staged changes",
    unstaged: "Unstaged changes",
  }[completion.scope]
  const untracked =
    completion.scope !== "staged" && completion.includeUntracked
      ? " · includes untracked files"
      : ""
  const base = completion.baseCommitId
    ? ` · base ${short(completion.baseCommitId)}`
    : ""
  return `${label}${untracked}${base}`
}

export function reviewIsComplete(review: Pick<Review, "publication">) {
  return review.publication.status !== "draft"
}

export function publicationLabel(review: Pick<Review, "publication">) {
  switch (review.publication.status) {
    case "draft":
      return "Local draft"
    case "completedLocal":
      return "Completed · local"
    case "publicationPending":
      return "Publication pending"
    case "published":
      return "Published"
    case "archived":
      return "Archived in Git"
  }
}

export function canKeepReviewLocal(review: Pick<Review, "publication">) {
  return !["published", "archived"].includes(review.publication.status)
}

export function canCompleteManually(
  review: Pick<Review, "publication" | "mode" | "files">
) {
  return (
    review.publication.status === "draft" &&
    review.mode === "manual" &&
    review.files.length > 0
  )
}

/** Terminal review states; pending publication still needs explicit attention. */
export function reviewIsFinalized(review: Pick<Review, "publication">) {
  return ["published", "completedLocal", "archived"].includes(
    review.publication.status
  )
}

/** Reopening a project resumes unfinished work, never a completed history entry. */
export function reviewToResume(reviews: Review[]) {
  return reviews
    .filter((review) => !reviewIsFinalized(review))
    .sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt))[0]
}
