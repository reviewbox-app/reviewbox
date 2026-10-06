import type {
  Review,
  ReviewAction,
  ReviewFinalization,
} from "@/lib/desktop/contracts.generated"
import { stepDecision } from "./review.helpers"

/** Only the last guided decision starts publication; file decisions stay independent. */
export function isFinalizationAction(review: Review, action: ReviewAction) {
  if (
    action.kind === "completeManualReview" ||
    action.kind === "completeUpdatedReview" ||
    action.kind === "retryPublication"
  )
    return true
  if (
    action.kind !== "validateStep" ||
    review.mode !== "guided" ||
    review.publication.status !== "draft" ||
    review.needsUpdateConfirmation
  )
    return false
  const steps = review.topics.flatMap((topic) => topic.steps)
  return (
    steps.some((step) => step.id === action.stepId) &&
    steps.every(
      (step) => step.id === action.stepId || !!stepDecision(review, step.id)
    )
  )
}

export function finalizationRetryAction(
  review: Review,
  original?: ReviewAction | null
): ReviewAction | null {
  if (review.publication.completion) return { kind: "retryPublication" }
  if (original) return original
  if (review.needsUpdateConfirmation) return { kind: "completeUpdatedReview" }
  if (review.mode === "manual") return { kind: "completeManualReview" }
  const pending = review.topics
    .flatMap((topic) => topic.steps)
    .filter((step) => !stepDecision(review, step.id))
  return pending.length === 1
    ? { kind: "validateStep", stepId: pending[0].id }
    : null
}

/** Replayed progress cannot turn a completed step back into a running one. */
export function newestFinalization(
  previous: ReviewFinalization | null,
  incoming: ReviewFinalization
) {
  return previous && previous.sequence >= incoming.sequence
    ? previous
    : incoming
}
