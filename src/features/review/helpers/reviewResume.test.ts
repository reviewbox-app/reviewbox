import { expect, test } from "bun:test"
import type { Review } from "@/lib/desktop/contracts.generated"
import { reviewIsFinalized, reviewToResume } from "./publication.helpers"

const review = (status: Review["publication"]["status"], updatedAt: string) =>
  ({
    id: `${status}-${updatedAt}`,
    updatedAt,
    publication: { status },
  }) as Review

test("opening a project never automatically resumes completed history", () => {
  const done = [
    review("published", "5"),
    review("completedLocal", "6"),
    review("archived", "7"),
  ]
  expect(reviewToResume(done)).toBeUndefined()
  const draft = review("draft", "1")
  expect(reviewToResume([...done, draft])).toBe(draft)
})
test("pending publication remains actionable even after the human decision was saved", () => {
  const pending = review("publicationPending", "4")
  expect(reviewIsFinalized(pending)).toBe(false)
  expect(
    reviewToResume([review("draft", "1"), pending, review("published", "5")])
  ).toBe(pending)
})
