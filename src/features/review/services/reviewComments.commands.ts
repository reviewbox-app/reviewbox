import { call } from "@/lib/desktop/review.commands"
import type {
  ReviewCommentMutation,
  ReviewCommentsDocument,
} from "@/lib/desktop/contracts.generated"

export const reviewCommentsCommands = {
  read: (repositoryId: string, reviewId: string) =>
    call<ReviewCommentsDocument>("read_review_comments", {
      repositoryId,
      reviewId,
    }),
  mutate: (
    repositoryId: string,
    reviewId: string,
    expectedRevision: string,
    mutation: ReviewCommentMutation
  ) =>
    call<ReviewCommentsDocument>("mutate_review_comment", {
      repositoryId,
      reviewId,
      expectedRevision,
      mutation,
    }),
}
