import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import type { Review, ReviewAction } from "@/lib/desktop/contracts.generated"
import {
  canCompleteManually,
  canKeepReviewLocal,
  reviewIsComplete,
} from "../helpers/publication.helpers"

/** Shared actions for the reader and Home; completion stays a native decision. */
export function ReviewLifecycleActions({
  review,
  busy,
  onAction,
}: {
  review: Review
  busy: boolean
  onAction: (action: ReviewAction) => void
}) {
  return (
    <>
      {review.needsUpdateConfirmation && (
        <DropdownMenuItem
          disabled={busy}
          onClick={() => onAction({ kind: "completeUpdatedReview" })}
        >
          Complete updated review
        </DropdownMenuItem>
      )}
      {canCompleteManually(review) && (
        <DropdownMenuItem
          disabled={busy}
          onClick={() => onAction({ kind: "completeManualReview" })}
          className="items-start"
        >
          <span>
            <span className="block">Complete review</span>
            <span className="block max-w-60 text-xs font-normal text-muted-foreground">
              Confirm you reviewed the captured scope.
            </span>
          </span>
        </DropdownMenuItem>
      )}
      {canKeepReviewLocal(review) && (
        <DropdownMenuCheckboxItem
          disabled={busy}
          checked={review.publication.keepLocal}
          onCheckedChange={(keepLocal) =>
            onAction({ kind: "setKeepLocal", keepLocal })
          }
        >
          Keep this review local
        </DropdownMenuCheckboxItem>
      )}
      {review.publication.status === "publicationPending" && (
        <DropdownMenuItem
          disabled={busy}
          onClick={() => onAction({ kind: "retryPublication" })}
        >
          Retry publication
        </DropdownMenuItem>
      )}
      {reviewIsComplete(review) && (
        <DropdownMenuItem
          disabled={busy}
          onClick={() => onAction({ kind: "reopenReview" })}
        >
          Review again
        </DropdownMenuItem>
      )}
      <DropdownMenuSeparator />
    </>
  )
}
