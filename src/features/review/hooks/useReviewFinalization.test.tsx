import { afterEach, expect, spyOn, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type {
  Review,
  ReviewFinalization,
} from "@/lib/desktop/contracts.generated"
import { reviewFinalizationCommands } from "../services/reviewFinalization.commands"
import { useReviewFinalization } from "./useReviewFinalization"

const review = {
  id: "review",
  repositoryId: "repo",
  revision: 7,
  mode: "guided",
  publication: { status: "draft", completion: null },
  topics: [],
  decisions: [],
} as unknown as Review
const action = { kind: "validateStep", stepId: "last" } as const
const operation: ReviewFinalization = {
  id: "operation",
  repositoryId: "repo",
  reviewId: "review",
  sequence: 1,
  action,
  status: "running",
  steps: [],
  error: null,
}
let restore: (() => void) | undefined
afterEach(() => {
  restore?.()
  restore = undefined
})

test("a pending start is deduplicated and remains active after native acknowledgement", async () => {
  let resolve!: (value: ReviewFinalization) => void
  const result = new Promise<ReviewFinalization>((done) => {
    resolve = done
  })
  const start = spyOn(reviewFinalizationCommands, "start").mockReturnValue(
    result
  )
  restore = () => start.mockRestore()
  let session!: ReturnType<typeof useReviewFinalization>
  function Probe() {
    session = useReviewFinalization(review)
    return null
  }
  renderToStaticMarkup(<Probe />)
  const first = session.start(review, action)
  expect(session.isActive()).toBe(true)
  expect(await session.start(review, action)).toBe(false)
  expect(start).toHaveBeenCalledTimes(1)
  expect(start).toHaveBeenCalledWith("repo", "review", 7, action)
  resolve(operation)
  expect(await first).toBe(true)
  expect(session.isActive()).toBe(true)
})

test("a fast native completion is accepted without keeping a false running state", async () => {
  const start = spyOn(reviewFinalizationCommands, "start").mockResolvedValue({
    ...operation,
    status: "completed",
    sequence: 10,
  })
  restore = () => start.mockRestore()
  let session!: ReturnType<typeof useReviewFinalization>
  function Probe() {
    session = useReviewFinalization(review)
    return null
  }
  renderToStaticMarkup(<Probe />)
  expect(await session.start(review, action)).toBe(true)
  expect(session.isActive()).toBe(false)
})
