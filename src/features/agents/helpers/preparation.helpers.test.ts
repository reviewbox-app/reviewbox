import { groupFileAnchors } from "@/features/review/helpers/review.helpers"
import { describe, expect, it } from "bun:test"
import type { Snapshot, Topic } from "@/lib/desktop/contracts.generated"
import { anchorLabel, outsidePreparation } from "./preparation.helpers"

const snapshot: Snapshot = {
  id: "snapshot",
  repositoryId: "repository",
  createdAt: "2026-09-27",
  request: {
    repositoryId: "repository",
    scope: "local",
    base: null,
    target: null,
    includeUntracked: false,
  },
  head: "head",
  gitRefs: [],
  headFingerprint: "head",
  workspaceFingerprint: "worktree",
  indexFingerprint: "index",
  files: [],
  changes: [
    {
      id: "change",
      path: "source.ts",
      previousPath: null,
      layer: "staged",
      before: null,
      after: null,
      binary: false,
      passages: [
        {
          id: "passage",
          oldStart: 7,
          oldLines: 2,
          newStart: 7,
          newLines: 0,
          fingerprint: "fingerprint",
        },
        {
          id: "other",
          oldStart: 20,
          oldLines: 1,
          newStart: 20,
          newLines: 1,
          fingerprint: "other",
        },
      ],
    },
  ],
}
const anchor = {
  snapshotId: "snapshot",
  changeId: "change",
  passageId: "passage",
}
const topic: Topic = {
  id: "topic",
  title: "Topic",
  brief: "Purpose",
  steps: [
    {
      id: "step",
      title: "Step",
      explanation: "Why",
      anchors: [anchor, anchor],
    },
  ],
}

describe("preparation coverage", () => {
  it("counts each frozen passage once and only considers accepted, valid topics", () => {
    expect(
      outsidePreparation(snapshot, [
        { topic, choice: "pending", diagnostics: [] },
      ])
    ).toHaveLength(2)
    expect(
      outsidePreparation(snapshot, [
        { topic, choice: "rejected", diagnostics: [] },
      ])
    ).toHaveLength(2)
    expect(
      outsidePreparation(snapshot, [
        { topic, choice: "accepted", diagnostics: [] },
      ])
    ).toHaveLength(1)
    expect(
      outsidePreparation(snapshot, [
        {
          topic,
          choice: "accepted",
          diagnostics: [
            { topicIndex: 0, stepIndex: 0, anchorIndex: 0, message: "Invalid" },
          ],
        },
      ])
    ).toHaveLength(2)
  })
  it("uses the deleted side for deleted passages and never labels stale anchors as current", () => {
    expect(anchorLabel(snapshot, anchor)).toBe("source.ts · staged · 7–8")
    expect(anchorLabel(snapshot, { ...anchor, snapshotId: "old" })).toBe(
      "Another snapshot"
    )
    expect(anchorLabel(snapshot, { ...anchor, passageId: "invented" })).toBe(
      "Unresolved passage"
    )
  })
})

it("groups outside changes by file across Git layers without treating partial coverage as complete", () => {
  const layered: Snapshot = {
    ...snapshot,
    changes: [
      ...snapshot.changes,
      {
        ...snapshot.changes[0],
        id: "unstaged",
        layer: "unstaged",
        passages: [{ ...snapshot.changes[0].passages[0], id: "new-edit" }],
      },
      {
        ...snapshot.changes[0],
        id: "new-file",
        path: "new.ts",
        layer: "untracked",
        passages: [{ ...snapshot.changes[0].passages[0], id: "new-source" }],
      },
    ],
  }
  const groups = groupFileAnchors(
    layered,
    outsidePreparation(layered, [
      { topic, choice: "accepted", diagnostics: [] },
    ])
  )
  expect(groups).toHaveLength(2)
  expect(groups[0]).toMatchObject({
    path: "source.ts",
    total: 3,
    layers: ["staged", "unstaged"],
  })
  expect(groups[0].anchors).toHaveLength(2)
  expect(groups[1]).toMatchObject({
    path: "new.ts",
    total: 1,
    layers: ["untracked"],
  })
  expect(
    groupFileAnchors(layered, [
      { ...anchor, snapshotId: "old" },
      { ...anchor, passageId: "invented" },
    ])
  ).toEqual([])
})
