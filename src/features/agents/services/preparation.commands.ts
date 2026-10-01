import { call } from "@/lib/desktop/review.commands"
import type { PreparationState } from "@/lib/desktop/contracts.generated"
export const preparationCommands = {
  update: (
    reviewId: string,
    revision: number,
    provider: string,
    repositoryId: string
  ) =>
    call<PreparationState | null>("update_review_with_rev", {
      reviewId,
      revision,
      provider,
      repositoryId,
    }),
  discardUpdate: (reviewId: string, repositoryId: string) =>
    call<void>("discard_review_update", { reviewId, repositoryId }),
  start: (reviewId: string, provider: string) =>
    call<PreparationState>("start_review_preparation", {
      request: { reviewId, provider },
    }),
  get: (reviewId: string, afterSequence?: number, repositoryId?: string) =>
    call<PreparationState | null>("get_review_preparation", {
      reviewId,
      afterSequence,
      ...(repositoryId ? { repositoryId } : {}),
    }),
  resume: (reviewId: string, repositoryId?: string) =>
    call<PreparationState>("resume_review_preparation", {
      reviewId,
      ...(repositoryId ? { repositoryId } : {}),
    }),
  cancel: (reviewId: string, repositoryId?: string) =>
    call<void>("cancel_review_preparation", {
      reviewId,
      ...(repositoryId ? { repositoryId } : {}),
    }),
}
