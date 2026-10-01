import { expect, test } from "bun:test"
import type {
  PreparationState,
  Workspace,
} from "@/lib/desktop/contracts.generated"
import {
  matchesReviewUpdate,
  matchesReviewPreparation,
  reviewUpdateChanged,
  updateProgress,
} from "./reviewUpdate.helpers"

function state(): PreparationState {
  return {
    id: "update",
    reviewId: "review",
    snapshotId: "candidate",
    provider: "codex",
    status: "running",
    phase: "outline",
    completedBatches: 0,
    totalBatches: 1,
    steps: [],
    events: [],
    error: null,
    startedAt: "10",
    updatedAt: "20",
    canResume: false,
    activeBatches: [],
    phases: [],
    adaptation: {
      operationId: "update",
      provider: "codex",
      sourceReviewId: "review",
      snapshotId: "old",
      sourceRevision: 3,
      candidateReviewId: "private",
      destinationReviewId: "review",
      retainedSteps: 8,
      rewrittenSteps: 2,
      addedSteps: 0,
      removedSteps: 0,
    },
  }
}
const workspace = (snapshot = "old", review = "review") =>
  ({
    review: { id: review },
    snapshot: { id: snapshot },
  }) as Workspace

test("unchanged polls do not refresh the reader while new progress and compatibility changes do", () => {
  const previous = state()
  previous.events = [
    { runId: previous.id, sequence: 1, kind: "status", text: "Reading" },
  ]
  expect(reviewUpdateChanged(null, previous, 0)).toBe(true)
  expect(reviewUpdateChanged(previous, { ...previous, events: [] }, 1)).toBe(
    false
  )
  expect(reviewUpdateChanged(previous, structuredClone(previous), 1)).toBe(
    false
  )
  expect(
    reviewUpdateChanged(
      previous,
      { ...previous, events: [{ ...previous.events[0], sequence: 2 }] },
      1
    )
  ).toBe(true)
  expect(
    reviewUpdateChanged(
      previous,
      {
        ...previous,
        events: [{ ...previous.events[0], runId: "old", sequence: 2 }],
      },
      1
    )
  ).toBe(false)
  expect(
    reviewUpdateChanged(previous, { ...previous, canResume: true }, 1)
  ).toBe(true)
  expect(
    reviewUpdateChanged(previous, { ...previous, status: "ready" }, 1)
  ).toBe(true)
  expect(
    reviewUpdateChanged(previous, { ...previous, id: "replacement" }, 1)
  ).toBe(true)
  expect(
    reviewUpdateChanged(
      previous,
      {
        ...previous,
        error: {
          code: "conflict",
          message: "Source changed",
          retryable: false,
        },
      },
      1
    )
  ).toBe(true)
})

test("update events belong to the displayed baseline while preparing a distinct candidate", () => {
  const value = state()
  expect(matchesReviewUpdate(value, workspace())).toBe(true)
  expect(matchesReviewUpdate(value, workspace("another"))).toBe(false)
  expect(matchesReviewUpdate(value, workspace("old", "another"))).toBe(false)
  expect(
    matchesReviewUpdate({ ...value, adaptation: undefined }, workspace())
  ).toBe(false)
  expect(matchesReviewUpdate(value, workspace("candidate"))).toBe(false)
  expect(
    matchesReviewUpdate({ ...value, status: "ready" }, workspace("candidate"))
  ).toBe(true)
  value.adaptation!.destinationReviewId = "fork"
  expect(
    matchesReviewUpdate({ ...value, status: "ready" }, workspace("candidate"))
  ).toBe(false)
})
test("update progress ignores duplicates, preserves cancellation and resumes its own sequence", () => {
  const value = state()
  value.events = [
    {
      runId: "update",
      sequence: 1,
      kind: "progress",
      text: "",
      progress: { type: "message", id: "m", text: "Impact checked" },
    },
  ]
  const first = updateProgress(null, value)
  expect(updateProgress(first, value).entries).toHaveLength(1)
  const cancelled = updateProgress(first, {
    ...value,
    status: "cancelled",
    canResume: true,
  })
  expect(cancelled.outcome).toBe("cancelled")
  const resumed = updateProgress(cancelled, {
    ...value,
    updatedAt: "30",
    events: [
      { ...value.events[0], sequence: 2, runId: "older-operation" },
      {
        ...value.events[0],
        sequence: 3,
        progress: {
          type: "message",
          id: "m2",
          text: "Resuming retained results",
        },
      },
    ],
  })
  expect(resumed.outcome).toBeUndefined()
  expect(resumed.entries).toHaveLength(2)
  expect(resumed.sequence).toBe(3)
  expect(
    updateProgress(resumed, { ...value, id: "replacement", events: [] }).entries
  ).toHaveLength(0)
})

test("creation and completed forks remain scoped to the correct review and captured content", () => {
  const creation = { ...state(), adaptation: undefined, snapshotId: "old" }
  expect(matchesReviewPreparation(creation, workspace())).toBe(true)
  expect(matchesReviewPreparation(creation, workspace("new"))).toBe(false)
  expect(matchesReviewPreparation(creation, workspace("old", "other"))).toBe(
    false
  )
  const fork = state()
  fork.adaptation!.destinationReviewId = "fork"
  expect(matchesReviewPreparation(fork, workspace("candidate", "fork"))).toBe(
    false
  )
  fork.status = "ready"
  expect(matchesReviewPreparation(fork, workspace("candidate", "fork"))).toBe(
    true
  )
  expect(matchesReviewPreparation(fork, workspace("old", "fork"))).toBe(false)
})
