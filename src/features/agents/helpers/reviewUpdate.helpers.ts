import type {
  PreparationState,
  Workspace,
} from "@/lib/desktop/contracts.generated"
import {
  beginProgress,
  finishProgress,
  receiveProgress,
  type PreparationProgress,
} from "./preparationProgress.helpers"

/** Poll responses contain only events newer than the requested sequence. */
export function reviewUpdateChanged(
  previous: PreparationState | null,
  next: PreparationState,
  sequence: number
) {
  if (!previous) return true
  if (
    next.events.some(
      (event) => event.runId === next.id && event.sequence > sequence
    )
  )
    return true
  return (
    JSON.stringify({ ...previous, events: [] }) !==
    JSON.stringify({ ...next, events: [] })
  )
}

/** A candidate deliberately differs from the capture still displayed. */
export function matchesReviewUpdate(
  value: PreparationState,
  workspace: Workspace
) {
  const update = value.adaptation
  if (
    update &&
    value.status === "ready" &&
    update.destinationReviewId === workspace.review.id &&
    value.snapshotId === workspace.snapshot.id &&
    (value.reviewId === update.sourceReviewId ||
      value.reviewId === update.destinationReviewId)
  )
    return true
  return (
    !!update &&
    value.reviewId === workspace.review.id &&
    update.sourceReviewId === workspace.review.id &&
    (update.snapshotId === workspace.snapshot.id ||
      (value.status === "ready" &&
        value.snapshotId === workspace.snapshot.id &&
        update.destinationReviewId === workspace.review.id))
  )
}
/** Creation tracks the visible capture; adaptation tracks its verified baseline. */
export function matchesReviewPreparation(
  value: PreparationState,
  workspace: Workspace
) {
  return value.adaptation
    ? matchesReviewUpdate(value, workspace)
    : value.reviewId === workspace.review.id &&
        value.snapshotId === workspace.snapshot.id
}

export function updateProgress(
  old: PreparationProgress | null,
  value: PreparationState
) {
  let next =
    old?.runId === value.id
      ? old
      : beginProgress(value.id, Number(value.startedAt))
  if (value.status === "running" && next.outcome)
    next = { ...next, outcome: undefined, endedAt: undefined }
  for (const event of value.events) next = receiveProgress(next, event)
  return value.status === "running"
    ? next
    : finishProgress(
        next,
        value.status === "ready"
          ? "completed"
          : value.status === "failed"
            ? "failed"
            : "cancelled",
        Number(value.updatedAt)
      )
}
