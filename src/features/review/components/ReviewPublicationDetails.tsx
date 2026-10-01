import { HugeiconsIcon } from "@hugeicons/react"
import { InformationCircleIcon } from "@hugeicons/core-free-icons"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import type { Review, ReviewAction } from "@/lib/desktop/contracts.generated"
import {
  completionScopeLabel,
  publicationLabel,
} from "../helpers/publication.helpers"
import { authorOf, shortTime } from "../helpers/review.helpers"

export function ReviewPublicationDetails({
  review,
  busy = false,
  onAction,
}: {
  review: Review
  busy?: boolean
  onAction: (action: ReviewAction) => void
}) {
  const publication = review.publication
  const completion = publication.completion
  return (
    <div className="space-y-3 text-sm text-muted-foreground">
      {review.needsUpdateConfirmation && (
        <Alert variant="faded" size="sm">
          <HugeiconsIcon icon={InformationCircleIcon} />
          <AlertDescription>
            All step validations were preserved. Confirm the new captured scope
            to complete this updated review.
            <Button
              size="sm"
              className="mt-2"
              disabled={busy}
              onClick={() => onAction({ kind: "completeUpdatedReview" })}
            >
              Complete updated review
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {completion ? (
        <p>
          {completion.kind === "manual"
            ? "Manual review: the captured scope was confirmed by the reviewer."
            : "Guided review: all authored steps were validated. File decisions remain separate."}{" "}
          {authorOf(completion.author).name} ·{" "}
          {shortTime(completion.completedAt)}
        </p>
      ) : (
        <p>
          {publication.keepLocal
            ? "This review stays local when completed."
            : "This local draft will be published in the repository when completed."}
        </p>
      )}
      {completion && (
        <p
          className="break-words"
          title={
            [completion.baseCommitId, completion.targetCommitId]
              .filter(Boolean)
              .join(" → ") || undefined
          }
        >
          Scope: {completionScopeLabel(completion)}.
        </p>
      )}
      {publication.status === "completedLocal" && (
        <p>Completed and kept local.</p>
      )}
      {publication.status === "published" && (
        <p>
          Published in the repository. Commit and push it with your changes.
        </p>
      )}
      {publication.archive && (
        <p>
          Review archived in commit{" "}
          <code title={publication.archive.commitId}>
            {publication.archive.commitId.slice(0, 10)}
          </code>
          .
        </p>
      )}
      {publication.matchingCommitIds.length > 0 && (
        <p className="break-words">
          Captured code and scope match{" "}
          {publication.matchingCommitIds.length === 1 ? "commit" : "commits"}{" "}
          {publication.matchingCommitIds.map((commit, index) => (
            <span key={commit}>
              {index > 0 && ", "}
              <code title={commit}>{commit.slice(0, 10)}</code>
            </span>
          ))}
          .
        </p>
      )}
      {publication.status === "publicationPending" && (
        <Alert variant="faded" size="sm">
          <HugeiconsIcon icon={InformationCircleIcon} />
          <AlertDescription className="space-y-2">
            <p className="font-medium">{publicationLabel(review)}</p>
            <p>
              {publication.publicationError ??
                "Your validation is saved locally. Retry publishing when the repository is available."}
            </p>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => onAction({ kind: "retryPublication" })}
            >
              Retry publication
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {publication.archiveDeferredReason && (
        <p>{publication.archiveDeferredReason}</p>
      )}
    </div>
  )
}
