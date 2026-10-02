"use client"

import { useEffect, useState } from "react"
import { useTheme } from "next-themes"
import { Button } from "@/components/ui/button"
import { ReviewCodePane } from "@/features/review/composites/ReviewCodePane"
import { reviewCommands } from "@/lib/desktop/review.commands"
import type {
  Change,
  CodeAnchor,
  ReadingPosition,
  Snapshot,
} from "@/lib/desktop/contracts.generated"
import { documentBefore, documentAfter } from "../fixtures/documentDiff.fixture"

import {
  blockBefore,
  blockAfter,
  largeBlockBefore,
  largeBlockAfter,
} from "../fixtures/blockDiff.fixture"

const changes: Change[] = [
  "README.md",
  "LICENSE",
  "notes.TXT",
  "CMakeLists.txt",
  "README.mdx",
  "NEW.md",
  "DELETED.md",
  "blocks.ts",
  "large-block.ts",
].map((path) => ({
  id: path,
  path,
  previousPath: null,
  untracked: false,
  layer: "unstaged",
  binary: false,
  before:
    path === "NEW.md"
      ? null
      : { hash: "before", size: documentBefore.length, mode: "100644" },
  after:
    path === "DELETED.md"
      ? null
      : { hash: "after", size: documentAfter.length, mode: "100644" },
  passages: [
    {
      id: "passage",
      oldStart: 3,
      oldLines: 1,
      newStart: 3,
      newLines: 1,
      fingerprint: "fixture",
    },
  ],
}))
const snapshot: Snapshot = {
  id: "document-preview",
  repositoryId: "fixture",
  head: "head",
  gitRefs: [],
  createdAt: "2026-09-30",
  headFingerprint: "head",
  workspaceFingerprint: "workspace",
  indexFingerprint: "index",
  files: [],
  changes,
  request: {
    repositoryId: "fixture",
    scope: "local",
    base: null,
    target: null,
    includeUntracked: false,
  },
}
const initialPosition: ReadingPosition = {
  context: "files",
  fileId: "README.md",
  changeId: null,
  passageId: null,
  stepId: null,
  line: 0,
  scrollTop: 0,
  split: false,
}

/** Isolated development route: only the captured-content read is replaced. */
export function DocumentDiffWorkbench() {
  const [ready, setReady] = useState(false)
  const [change, setChange] = useState(changes[0])
  const [refresh, setRefresh] = useState(0)
  const [position, setPosition] = useState(initialPosition)
  const [reference, setReference] = useState<CodeAnchor | null>(null)
  const { setTheme } = useTheme()
  useEffect(() => {
    const read = reviewCommands.content
    reviewCommands.content = async (_snapshotId, changeId) => ({
      before:
        changeId === "large-block.ts"
          ? largeBlockBefore
          : changeId === "blocks.ts"
            ? blockBefore
            : changeId === "NEW.md"
              ? null
              : changeId === "notes.TXT"
                ? "Notes before\nSecond line"
                : documentBefore,
      after:
        changeId === "large-block.ts"
          ? largeBlockAfter
          : changeId === "blocks.ts"
            ? blockAfter
            : changeId === "DELETED.md"
              ? null
              : changeId === "notes.TXT"
                ? "Notes after\nSecond line"
                : documentAfter,
      unavailableReason: null,
    })
    let active = true
    queueMicrotask(() => {
      if (active) setReady(true)
    })
    const timer = setInterval(() => setRefresh((value) => value + 1), 750)
    return () => {
      active = false
      clearInterval(timer)
      reviewCommands.content = read
    }
  }, [])
  const openReference = () =>
    setReference({
      snapshotId: snapshot.id,
      changeId: change.id,
      passageId: "reference",
    })
  return (
    <main className="flex h-screen flex-col">
      <nav className="flex flex-wrap items-center gap-2 border-b p-2">
        {changes.map((item) => (
          <Button
            key={item.id}
            size="sm"
            variant="ghost"
            onClick={() => {
              setChange(item)
              setReference(null)
            }}
          >
            {item.path}
          </Button>
        ))}
        <Button size="sm" onClick={openReference}>
          Open in code
        </Button>
        {change.id === "blocks.ts" && (
          <Button
            size="sm"
            onClick={() =>
              setReference({
                snapshotId: snapshot.id,
                changeId: change.id,
                passageId: "old-block",
              })
            }
          >
            Open old block
          </Button>
        )}
        {reference && (
          <Button size="sm" onClick={() => setReference(null)}>
            Close reference
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => setTheme("light")}>
          Light
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setTheme("dark")}>
          Dark
        </Button>
        <output data-testid="refresh-count">{refresh}</output>
      </nav>
      <div className="relative min-h-0 flex-1">
        {ready && (
          <ReviewCodePane
            key={`${change.id}/${!!reference}`}
            snapshot={{ ...snapshot }}
            change={{ ...change }}
            passage={
              reference
                ? {
                    ...change.passages[0],
                    id: "reference",
                    oldStart: reference.passageId === "old-block" ? 19 : 219,
                    oldLines: reference.passageId === "old-block" ? 2 : 3,
                    newStart: reference.passageId === "old-block" ? 18 : 219,
                    newLines: reference.passageId === "old-block" ? 0 : 3,
                  }
                : change.passages[0]
            }
            selection={reference}
            position={position}
            onPosition={setPosition}
            overlay={{ top: 0, bottom: 0 }}
            modelScope={reference ? "reference" : "reader"}
          />
        )}
      </div>
    </main>
  )
}
