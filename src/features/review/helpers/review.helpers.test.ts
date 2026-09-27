import { expect, test } from "bun:test"
import type { CodeAnchor, Review } from "@/lib/desktop/contracts.generated"
import { readingStep, topicStatus } from "./review.helpers"

const anchor: CodeAnchor = {
  snapshotId: "snapshot",
  changeId: "change",
  passageId: "passage",
}
const review: Pick<Review, "topics" | "position"> = {
  position: {
    changeId: "change",
    passageId: "passage",
    stepId: "second",
    line: 0,
    scrollTop: 0,
    split: false,
  },
  topics: [
    {
      id: "topic",
      title: "Title",
      brief: "Brief",
      steps: [
        { id: "first", title: "First", explanation: "", anchors: [anchor] },
        {
          id: "second",
          title: "Second",
          explanation: "",
          anchors: [anchor, { ...anchor, passageId: "other" }],
        },
      ],
    },
  ],
}
test("repeated passage preserves the explicitly selected reading step", () => {
  expect(readingStep(review, anchor)?.step.id).toBe("second")
  expect(readingStep(review, { ...anchor, passageId: "other" })?.step.id).toBe(
    "second"
  )
})
test("file navigation falls back to its first matching step, never a different snapshot", () => {
  expect(
    readingStep(
      { ...review, position: { ...review.position, stepId: null } },
      anchor
    )?.step.id
  ).toBe("first")
  expect(
    readingStep(review, { ...anchor, snapshotId: "stale" })
  ).toBeUndefined()
  expect(readingStep(review, null)).toBeUndefined()
})
test("a step with several anchors is validated only when every anchor is validated", () => {
  expect(topicStatus(["Validated", "Unread"])).toBe("In progress")
  expect(topicStatus(["Validated", "Validated"])).toBe("Validated")
  expect(topicStatus(["Validated", "Re-review"])).toBe("Re-review")
})
