import { expect, test } from "bun:test"
import type {
  PublicationStatus,
  Review,
  ReviewCompletion,
  ReviewPublication,
} from "@/lib/desktop/contracts.generated"
import {
  canCompleteManually,
  canKeepReviewLocal,
  completionScopeLabel,
  publicationLabel,
  reviewIsComplete,
} from "./publication.helpers"

test("completion distinguishes the reviewed scope from its archive carrier", () => {
  const completion: ReviewCompletion = {
    kind: "manual",
    author: "human:reviewer",
    completedAt: "1",
    scopeFingerprint: "captured-scope",
    scope: "local",
    includeUntracked: true,
    baseCommitId: "a".repeat(40),
    targetCommitId: "b".repeat(40),
  }
  expect(completionScopeLabel(completion)).toBe(
    "Local changes · includes untracked files · base aaaaaaaaaa"
  )
  expect(completionScopeLabel({ ...completion, scope: "staged" })).toBe(
    "Staged changes · base aaaaaaaaaa"
  )
  expect(
    completionScopeLabel({
      ...completion,
      scope: "unstaged",
      includeUntracked: false,
    })
  ).toBe("Unstaged changes · base aaaaaaaaaa")
  expect(completionScopeLabel({ ...completion, scope: "commit" })).toBe(
    "Commit bbbbbbbbbb"
  )
  expect(completionScopeLabel({ ...completion, scope: "range" })).toBe(
    "Range aaaaaaaaaa…bbbbbbbbbb"
  )
})

function review(status: PublicationStatus) {
  const publication: ReviewPublication = {
    status,
    keepLocal: false,
    completion: null,
    originReviewId: null,
    archive: null,
    matchingCommitIds: [],
    publicationError: null,
    archiveDeferredReason: null,
    fileCount: null,
    stepCount: null,
  }
  return { publication }
}

test("saved human completion stays complete when publication fails or stays local", () => {
  expect(reviewIsComplete(review("draft"))).toBe(false)
  for (const status of [
    "completedLocal",
    "publicationPending",
    "published",
    "archived",
  ] as const) {
    expect(reviewIsComplete(review(status))).toBe(true)
  }
  expect(publicationLabel(review("completedLocal"))).toBe("Completed · local")
  expect(publicationLabel(review("publicationPending"))).toBe(
    "Publication pending"
  )
})

test("shared artifacts cannot be silently made private from the reader", () => {
  for (const status of [
    "draft",
    "completedLocal",
    "publicationPending",
  ] as const) {
    expect(canKeepReviewLocal(review(status))).toBe(true)
  }
  for (const status of ["published", "archived"] as const) {
    expect(canKeepReviewLocal(review(status))).toBe(false)
  }
})

test("only a nonempty manual draft exposes whole-scope completion", () => {
  const file: Review["files"][number] = {
    id: "file",
    path: "a.ts",
    changeIds: ["change"],
    hasDocuments: false,
  }
  expect(
    canCompleteManually({ ...review("draft"), mode: "manual", files: [file] })
  ).toBe(true)
  expect(
    canCompleteManually({ ...review("draft"), mode: "guided", files: [file] })
  ).toBe(false)
  expect(
    canCompleteManually({ ...review("draft"), mode: "manual", files: [] })
  ).toBe(false)
  expect(
    canCompleteManually({
      ...review("completedLocal"),
      mode: "manual",
      files: [file],
    })
  ).toBe(false)
})
