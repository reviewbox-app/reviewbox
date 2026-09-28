import { call } from "@/lib/desktop/review.commands"
import type { PreparationState } from "@/lib/desktop/contracts.generated"
export const preparationCommands = {
  start: (reviewId: string, provider: string) =>
    call<PreparationState>("start_review_preparation", {
      request: { reviewId, provider },
    }),
  get: (reviewId: string, afterSequence?: number) =>
    call<PreparationState | null>("get_review_preparation", {
      reviewId,
      afterSequence,
    }),
  resume: (reviewId: string) =>
    call<PreparationState>("resume_review_preparation", { reviewId }),
  cancel: (reviewId: string) =>
    call<void>("cancel_review_preparation", { reviewId }),
}
