import { expect, test } from "bun:test"
import type {
  CodeAnchor,
  LevelDocuments,
  Workspace,
} from "@/lib/desktop/contracts.generated"
import {
  currentUnit,
  fileDecision,
  guidedProgress,
  nextReaderTarget,
  pseudoAvailable,
  readerCursorKey,
  readingStep,
  readingUnits,
  stepDecision,
  changeStatus,
  previousFilePaths,
} from "./review.helpers"

const anchor: CodeAnchor = {
  snapshotId: "snapshot",
  changeId: "change",
  passageId: "passage",
}
const doc = {
  body: "Explanation",
  termAliases: {},
  readingSeconds: 30,
  references: [],
  terms: [],
}
const documents: LevelDocuments = {
  glossary: [],
  beginner: doc,
  intermediate: doc,
  developer: doc,
}
const blob = { hash: "hash", size: 10, mode: "100644" }
const passage = (id: string) => ({
  id,
  oldStart: 1,
  oldLines: 1,
  newStart: 1,
  newLines: 1,
  fingerprint: id,
})
function fixture(): Workspace {
  return {
    review: {
      glossary: [],
      id: "review",
      title: "Review",
      repositoryId: "repo",
      snapshotId: "snapshot",
      previousSnapshotIds: [],
      revision: 1,
      topics: [
        {
          id: "topic",
          title: "Topic",
          brief: "",
          steps: [
            { id: "first", title: "First", documents, anchors: [anchor] },
            { id: "second", title: "Second", documents, anchors: [anchor] },
          ],
        },
      ],
      mode: "guided",
      preparationId: null,
      files: [
        {
          id: "file-a",
          path: "a.ts",
          changeIds: ["change", "unstaged"],
          hasDocuments: true,
          pseudocodeSkipReason: null,
          translations: [],
        },
        {
          id: "file-b",
          path: "b.ts",
          changeIds: ["other"],
          hasDocuments: false,
          pseudocodeSkipReason: null,
          translations: [],
        },
      ],
      decisions: [],
      examined: [],
      position: {
        context: "guided",
        fileId: "file-b",
        changeId: "change",
        passageId: "passage",
        stepId: "second",
        line: 0,
        scrollTop: 0,
        split: false,
      },
      createdAt: "0",
      updatedAt: "0",
    },
    snapshot: {
      id: "snapshot",
      repositoryId: "repo",
      createdAt: "0",
      gitRefs: [],
      head: "head",
      headFingerprint: "head",
      indexFingerprint: "index",
      workspaceFingerprint: "workspace",
      request: {
        repositoryId: "repo",
        scope: "local",
        base: null,
        target: null,
        includeUntracked: true,
      },
      files: [],
      changes: [
        {
          id: "change",
          path: "a.ts",
          previousPath: null,
          layer: "staged",
          before: blob,
          after: blob,
          binary: false,
          untracked: false,
          passages: [passage("passage"), passage("left-out")],
        },
        {
          id: "unstaged",
          path: "a.ts",
          previousPath: null,
          layer: "unstaged",
          before: blob,
          after: blob,
          binary: false,
          untracked: false,
          passages: [passage("unstaged")],
        },
        {
          id: "other",
          path: "b.ts",
          previousPath: null,
          layer: "unstaged",
          before: null,
          after: blob,
          binary: false,
          untracked: true,
          passages: [passage("other")],
        },
      ],
    },
  }
}

test("guided count contains only Rev steps and preserves an explicitly selected repeated passage", () => {
  const workspace = fixture()
  expect(readingUnits(workspace).map((u) => u.key)).toEqual([
    "step:first",
    "step:second",
  ])
  expect(currentUnit(workspace)?.index).toBe(1)
  expect(readingStep(workspace.review)?.step.id).toBe("second")
  expect(nextReaderTarget(workspace, 1)).toBeNull()
})
test("file navigation never adopts the guided step that contains the file", () => {
  const workspace = fixture()
  workspace.review.position.context = "files"
  workspace.review.position.fileId = "file-a"
  expect(currentUnit(workspace)).toBeNull()
  expect(readingStep(workspace.review)).toBeUndefined()
  expect(nextReaderTarget(workspace, 1)).toEqual({
    kind: "file",
    fileId: "file-b",
  })
  expect(workspace.review.position.stepId).toBe("second")
  expect(readerCursorKey(workspace)).toBe("repo/review/snapshot/files/file-a")
})
test("file and overlapping step decisions remain independent and only steps complete the guide", () => {
  const workspace = fixture()
  const decision = {
    id: "decision",
    author: "human:test",
    fingerprint: "fp",
    state: "validated" as const,
    createdAt: "0",
  }
  workspace.review.decisions.push({
    ...decision,
    target: { kind: "file", fileId: "file-a" },
  })
  expect(fileDecision(workspace.review, "file-a")).toBeDefined()
  expect(guidedProgress(workspace.review)).toEqual({
    total: 2,
    validated: 0,
    complete: false,
  })
  workspace.review.decisions.push({
    ...decision,
    id: "first",
    target: { kind: "step", stepId: "first" },
  })
  expect(stepDecision(workspace.review, "second")).toBeUndefined()
  expect(guidedProgress(workspace.review).validated).toBe(1)
  workspace.review.decisions.push({
    ...decision,
    id: "second",
    target: { kind: "step", stepId: "second" },
    state: "examined",
  })
  expect(guidedProgress(workspace.review).complete).toBe(false)
  workspace.review.decisions.at(-1)!.state = "validated"
  expect(guidedProgress(workspace.review).complete).toBe(true)
})
test("stale and broken steps retain their place, without valid anchors", () => {
  const workspace = fixture()
  workspace.review.topics[0].steps[1].anchors = [
    { ...anchor, snapshotId: "previous" },
  ]
  expect(readingUnits(workspace)).toHaveLength(2)
  expect(currentUnit(workspace)?.unit.anchors).toHaveLength(0)
})
test("intermediate file validation requires every present side of every layer", () => {
  const workspace = fixture()
  const file = workspace.review.files[0]
  for (const id of file.changeIds)
    for (const side of ["before", "after"])
      file.translations.push({
        sourceId: `change:${id}:${side}`,
        sourceHash: "hash",
        available: true,
        unavailableReason: null,
      })
  expect(pseudoAvailable(file, workspace.snapshot)).toBe(true)
  file.translations.at(-1)!.available = false
  expect(pseudoAvailable(file, workspace.snapshot)).toBe(false)
  const added = workspace.review.files[1]
  added.translations = [
    {
      sourceId: "change:other:after",
      sourceHash: "hash",
      available: true,
      unavailableReason: null,
    },
  ]
  expect(pseudoAvailable(added, workspace.snapshot)).toBe(true)
  expect(changeStatus(workspace.snapshot.changes[2])).toBe("U")
})

test("cloned reviews retain distinct cursor ownership", () => {
  const first = fixture()
  const clone = structuredClone(first)
  clone.review.repositoryId = "other-clone"
  expect(readerCursorKey(clone)).not.toBe(readerCursorKey(first))
})

test("rename origins are unique across captured layers", () => {
  const workspace = fixture()
  workspace.snapshot.changes[0].previousPath = "former/a.ts"
  workspace.snapshot.changes[1].previousPath = "former/a.ts"
  expect(previousFilePaths(workspace.snapshot.changes)).toEqual(["former/a.ts"])
  expect(changeStatus(workspace.snapshot.changes[0])).toBe("R")
})

test("an explicit model omission needs no file document, while missing translations remain blocked", () => {
  const workspace = fixture()
  const file = workspace.review.files[0]
  expect(pseudoAvailable(file, workspace.snapshot)).toBe(false)
  file.pseudocodeSkipReason = "Only type declarations."
  expect(pseudoAvailable(file, workspace.snapshot)).toBe(true)
  file.hasDocuments = false
  expect(pseudoAvailable(file, workspace.snapshot)).toBe(true)
})
