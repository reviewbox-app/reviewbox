"use client"
import { useEffect, useState } from "react"
import { ReviewFiles } from "@/features/review/components/ReviewFiles"
import { ReviewCodePane } from "@/features/review/composites/ReviewCodePane"
import { reviewCommands } from "@/lib/desktop/review.commands"
import type { Change, Workspace } from "@/lib/desktop/contracts.generated"
import type { SourceSearchTarget } from "@/features/code-editor/contracts/sourceSelection.types"
const initialPosition = {
  context: "files" as const,
  fileId: null,
  changeId: null,
  passageId: null,
  stepId: null,
  line: 0,
  scrollTop: 0,
  split: false,
}

const contents = {
  "src/deep/colors.ts": {
    before: 'const color = "#ff0000";\nconst oldNeedle = 1;\n',
    after: 'const color = "#00ff00";\nconst newNeedle = 2;\n',
  },
  "docs/deleted.md": { before: "# Removed\nDeleted needle\n", after: null },
}
const changes: Change[] = Object.entries(contents).map(([path, content]) => ({
  id: path,
  path,
  previousPath: null,
  layer: "unstaged",
  binary: false,
  untracked: false,
  before: {
    hash: `before-${path}`,
    size: content.before.length,
    mode: "100644",
  },
  after: content.after
    ? { hash: `after-${path}`, size: content.after.length, mode: "100644" }
    : null,
  passages: [],
}))
// This fixture exercises the captured reader with deterministic source IPC.
const workspace = {
  snapshot: {
    id: "explorer-capture",
    repositoryId: "explorer-fixture",
    changes,
    files: [],
  },
  review: {
    id: "explorer-review",
    topics: [],
    decisions: [],
    files: changes.map((c) => ({
      id: c.id,
      path: c.path,
      changeIds: [c.id],
      hasDocuments: false,
    })),
  },
} as unknown as Workspace
export function ReviewExplorerWorkbench() {
  const [ready, setReady] = useState(false)
  const [active, setActive] = useState(changes[0].id)
  const [target, setTarget] = useState<SourceSearchTarget>()
  const [error, setError] = useState("")
  useEffect(() => {
    const original = reviewCommands.content
    reviewCommands.content = async (_, id) => ({
      ...contents[id as keyof typeof contents],
      unavailableReason: null,
    })
    const timer = setTimeout(() => setReady(true), 0)
    return () => {
      clearTimeout(timer)
      reviewCommands.content = original
    }
  }, [])
  const change = changes.find((c) => c.id === active)!
  return (
    <main className="flex h-screen gap-2 p-3">
      {error && <p role="alert">{error}</p>}
      <aside className="w-72 shrink-0">
        {ready && (
          <ReviewFiles
            workspace={workspace}
            selectedId={active}
            visible
            onError={setError}
            onSelect={(id) => {
              setTarget(undefined)
              setActive(id)
            }}
            onMatch={(id, match) => {
              setActive(id)
              setTarget({ ...match, token: crypto.randomUUID() })
            }}
          />
        )}
      </aside>
      <section
        className="relative flex min-w-0 flex-1 flex-col"
        aria-label="Captured source"
      >
        {ready && (
          <ReviewCodePane
            key={active}
            modelScope="local"
            snapshot={workspace.snapshot}
            change={change}
            source={{
              ...contents[active as keyof typeof contents],
              unavailableReason: null,
            }}
            selection={null}
            position={initialPosition}
            onPosition={() => {}}
            searchTarget={target}
          />
        )}
      </section>
    </main>
  )
}
