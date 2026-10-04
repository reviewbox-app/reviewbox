import { HugeiconsIcon } from "@hugeicons/react"
import { Alert02Icon } from "@hugeicons/core-free-icons"
import { CopyErrorDetailsButton } from "@/features/diagnostics/components/CopyErrorDetailsButton"
import type { Workspace } from "@/lib/desktop/contracts.generated"
import type { ReviewPreparationView } from "../contracts/preparation.types"

export function ReviewPreparationError({
  workspace,
  preparation,
}: {
  workspace: Workspace
  preparation: ReviewPreparationView
}) {
  if (!preparation.error) return null
  const state = preparation.state
  const error =
    preparation.errorDetails ??
    (state?.error?.message === preparation.error
      ? state.error
      : { message: preparation.error })
  return (
    <div className="space-y-1.5">
      <div
        role="alert"
        className="flex gap-2.5 rounded-2xl bg-destructive/10 p-4 text-sm text-destructive"
      >
        <HugeiconsIcon
          icon={Alert02Icon}
          size={16}
          className="mt-0.5 shrink-0"
        />
        <p className="min-w-0 wrap-anywhere">{preparation.error}</p>
      </div>
      <CopyErrorDetailsButton
        error={error}
        source="rev"
        operation="review_preparation"
        context={{
          repositoryId: workspace.review.repositoryId,
          reviewId: workspace.review.id,
          snapshotId: state?.snapshotId ?? workspace.snapshot.id,
          operationId: state?.id,
          provider: state?.provider,
          phase: state?.phase,
        }}
      />
    </div>
  )
}
