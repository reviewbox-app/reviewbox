import { listen } from "@tauri-apps/api/event"
import type {
  ReviewAction,
  ReviewFinalization,
} from "@/lib/desktop/contracts.generated"
import { call } from "@/lib/desktop/review.commands"

export const reviewFinalizationCommands = {
  start: (
    repositoryId: string,
    reviewId: string,
    revision: number,
    action: ReviewAction
  ) =>
    call<ReviewFinalization>("start_review_finalization", {
      repositoryId,
      reviewId,
      revision,
      action,
    }),
  get: (repositoryId: string, reviewId: string) =>
    call<ReviewFinalization | null>("get_review_finalization", {
      repositoryId,
      reviewId,
    }),
  subscribe: (receive: (operation: ReviewFinalization) => void) =>
    listen<ReviewFinalization>("reviewbox:review-finalization", ({ payload }) =>
      receive(payload)
    ),
}
