"use client"
import { useEffect, useState } from "react"
import { editorCommands } from "@/features/code-editor/services/editor.commands"
import type { EditorSearchMatch } from "@/lib/desktop/contracts.generated"
import { CodeEditorWorkspace } from "@/features/code-editor/composites/CodeEditorWorkspace"
import { EditorTabs } from "@/features/code-editor/components/EditorTabs"
import {
  updateEditor,
  moveEditorBuffer,
  useEditorStore,
  type EditorBuffer,
} from "@/features/code-editor/stores/editor.store"

const initialBuffers: EditorBuffer[] = ["TestComponents.tsx", "notes.md"].map(
  (path, index) => ({
    id: path,
    path,
    uri: "",
    text: index ? "draft" : "",
    baseText: "",
    revision: "fixture",
    readOnly: false,
    reason: null,
    version: 1,
    preview: false,
  })
)
export function EditorChromeWorkbench() {
  const [searches, setSearches] = useState<string[]>([])
  const [cancelled, setCancelled] = useState(0)
  const [inventoryTicks, setInventoryTicks] = useState(0)
  const ready = useEditorStore((s) => !!s.sessions["chrome-fixture"]?.ready)
  const [buffers, setBuffers] = useState(initialBuffers)
  const [active, setActive] = useState(initialBuffers[0].path)
  useEffect(() => {
    const original = {
      search: editorCommands.search,
      cancel: editorCommands.cancelSearch,
      read: editorCommands.read,
    }
    const files: Record<string, string> = {
      "src/example.ts": "export const needle = 1;",
      "docs/guide.md": "# Guide\nneedle one\nneedle two\n",
      "docs/notes.txt": "notes",
      "ignored.txt": "needle ignored",
    }
    editorCommands.read = async (_repository, path) => ({
      path,
      text: files[path] ?? "",
      uri: `file:///fixture/${path}`,
      revision: "fixture",
      readOnly: false,
      reason: null,
    })
    editorCommands.cancelSearch = async () => {
      setCancelled((n) => n + 1)
    }
    editorCommands.search = async (_repository, query, requestId) => {
      setSearches((queries) => [...queries, query])
      await new Promise((resolve) =>
        setTimeout(resolve, query === "slow" ? 750 : 20)
      )
      const matches: EditorSearchMatch[] = []
      for (const [path, text] of Object.entries(files)) {
        if (path === "ignored.txt") continue
        for (const [index, line] of text.split("\n").entries()) {
          const column = line.toLowerCase().indexOf(query.toLowerCase())
          if (column >= 0)
            matches.push({
              path,
              line: index + 1,
              column: column + 1,
              length: query.length,
              preview: line,
              previewColumn: column + 1,
            })
        }
      }
      return {
        requestId,
        matches,
        truncated: false,
        cancelled: false,
        scannedFiles: 3,
        skippedFiles: 0,
      }
    }
    updateEditor("chrome-fixture", (s) => ({
      ...s,
      ready: true,
      ignoredPaths: new Set(["ignored.txt"]),
      entries: [
        { path: "src", directory: true, revision: "fixture" },
        { path: "src/example.ts", directory: false, revision: "fixture" },
        { path: "ignored.txt", directory: false, revision: "fixture" },
        { path: "docs", directory: true, revision: "fixture" },
        { path: "docs/guide.md", directory: false, revision: "fixture" },
        { path: "docs/notes.txt", directory: false, revision: "fixture" },
      ],
    }))
    const polling = new URLSearchParams(window.location.search).has("poll")
      ? setInterval(() => {
          updateEditor("chrome-fixture", (s) => ({
            ...s,
            entries: s.entries.map((entry) => ({ ...entry })),
          }))
          setInventoryTicks((count) => count + 1)
        }, 250)
      : undefined
    return () => {
      clearInterval(polling)
      editorCommands.search = original.search
      editorCommands.cancelSearch = original.cancel
      editorCommands.read = original.read
    }
  }, [])
  return (
    <div className="flex h-screen flex-col p-4">
      <output className="sr-only" data-testid="inventory-ticks">
        {inventoryTicks}
      </output>
      <output className="sr-only" data-testid="content-search-requests">
        {JSON.stringify(searches)}
      </output>
      <output className="sr-only" data-testid="content-search-cancelled">
        {cancelled}
      </output>
      <section
        aria-label="Tab design preview"
        className="mb-4 rounded-panel border bg-card"
      >
        <EditorTabs
          onKeepOpen={() => {}}
          onMove={(source, target, after) =>
            setBuffers((current) =>
              moveEditorBuffer(current, source, target, after)
            )
          }
          buffers={buffers}
          active={active}
          onSelect={setActive}
          onClose={(buffer) => {
            const remaining = buffers.filter((b) => b.id !== buffer.id)
            setBuffers(remaining)
            if (active === buffer.path) setActive(remaining[0]?.path ?? "")
          }}
        />
      </section>
      {ready && <CodeEditorWorkspace repositoryId="chrome-fixture" />}
    </div>
  )
}
