import { listen } from "@tauri-apps/api/event"
import { call } from "@/lib/desktop/review.commands"
import type { ReviewCommitOperation } from "@/lib/desktop/contracts.generated"

export const reviewCommitCommands = {
  start: (repositoryId: string, reviewId: string) =>
    call<ReviewCommitOperation>("start_review_commit", {
      repositoryId,
      reviewId,
    }),
  get: (repositoryId: string, reviewId: string) =>
    call<ReviewCommitOperation | null>("get_review_commit", {
      repositoryId,
      reviewId,
    }),
  subscribe: (receive: (value: ReviewCommitOperation) => void) =>
    listen<ReviewCommitOperation>("reviewbox:review-commit", (event) =>
      receive(event.payload)
    ),
}
