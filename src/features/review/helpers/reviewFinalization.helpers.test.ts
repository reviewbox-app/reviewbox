import { expect, test } from "bun:test"
import type {
  Review,
  ReviewFinalization,
} from "@/lib/desktop/contracts.generated"
import {
  finalizationRetryAction,
  isFinalizationAction,
  newestFinalization,
} from "./reviewFinalization.helpers"

const review = {
  mode: "guided",
  publication: { status: "draft", completion: null },
  topics: [{ steps: [{ id: "a" }, { id: "b" }] }],
  decisions: [{ target: { kind: "step", stepId: "a" }, state: "validated" }],
  needsUpdateConfirmation: false,
} as unknown as Review

test("only the remaining guided validation starts finalization", () => {
  expect(
    isFinalizationAction(review, { kind: "validateStep", stepId: "b" })
  ).toBe(true)
  expect(
    isFinalizationAction(review, { kind: "validateStep", stepId: "a" })
  ).toBe(false)
  expect(
    isFinalizationAction(review, { kind: "validateStep", stepId: "unknown" })
  ).toBe(false)
  expect(
    isFinalizationAction(review, { kind: "validateFile", fileId: "file" })
  ).toBe(false)
  expect(
    isFinalizationAction(
      { ...review, mode: "manual" },
      { kind: "validateStep", stepId: "b" }
    )
  ).toBe(false)
})

test("an updated review requires its explicit completion action", () => {
  const updated = { ...review, needsUpdateConfirmation: true }
  expect(
    isFinalizationAction(updated, { kind: "validateStep", stepId: "b" })
  ).toBe(false)
  expect(isFinalizationAction(updated, { kind: "completeUpdatedReview" })).toBe(
    true
  )
  expect(isFinalizationAction(review, { kind: "completeManualReview" })).toBe(
    true
  )
})

test("retry preserves the original decision until durable completion, then only finalizes", () => {
  const action = { kind: "validateStep", stepId: "b" } as const
  expect(finalizationRetryAction(review, action)).toEqual(action)
  expect(finalizationRetryAction(review)).toEqual(action)
  const completed = {
    ...review,
    publication: { ...review.publication, completion: { kind: "guided" } },
  } as Review
  expect(finalizationRetryAction(completed, action)).toEqual({
    kind: "retryPublication",
  })
})

test("late events cannot regress a finalization that already finished", () => {
  const completed = {
    id: "operation",
    sequence: 12,
    status: "completed",
  } as ReviewFinalization
  expect(
    newestFinalization(completed, {
      ...completed,
      sequence: 8,
      status: "running",
    })
  ).toBe(completed)
  expect(newestFinalization(completed, { ...completed })).toBe(completed)
  const retried = {
    ...completed,
    id: "retry",
    sequence: 13,
    status: "running",
  } as ReviewFinalization
  expect(newestFinalization(completed, retried)).toBe(retried)
})
