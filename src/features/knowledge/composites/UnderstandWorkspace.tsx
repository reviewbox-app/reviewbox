"use client"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { SidebarResizeHandle } from "@/components/ui/sidebar-resize-handle"
import type { Snapshot } from "@/lib/desktop/contracts.generated"
import { errorMessage, reviewCommands } from "@/lib/desktop/review.commands"
import { capturedFileStatuses } from "@/lib/git/file-status"
import { Search01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useEffect, useState } from "react"
import { FileMenu } from "@/features/file-tree/components/FileMenu"
import { FileTree } from "@/features/file-tree/components/FileTree"
import { KnowledgeFile } from "./KnowledgeFile"

export function UnderstandWorkspace({
  snapshot,
  onError,
}: {
  snapshot: Snapshot
  onError: (error: string) => void
}) {
  const [path, setPath] = useState(snapshot.files[0]?.path ?? "")
  const [loaded, setLoaded] = useState<{
    path: string
    hash: string
    code: string
  } | null>(null)
  const [filter, setFilter] = useState("")
  const file = snapshot.files.find((f) => f.path === path)
  const hash = file?.content.hash
  const code =
    loaded?.path === path && loaded.hash === hash ? loaded.code : null
  useEffect(() => {
    let alive = true
    if (!path || !hash) return
    void reviewCommands
      .file(snapshot.id, path)
      .then((value) => {
        if (alive) setLoaded({ path, hash, code: value })
      })
      .catch((error) => {
        if (alive) {
          setLoaded(null)
          onError(errorMessage(error))
        }
      })
    return () => {
      alive = false
    }
  }, [snapshot.id, path, hash, onError])
  return () => {
      alive = false
    }
  }, [snapshot.id, snapshot.repositoryId, path, hash, code, onError])
  return (
    <div data-resize-workspace className="flex min-h-0 flex-1 gap-2 px-2 pb-2">
      <aside
        aria-label="Code Explain files"
        className="relative flex w-[clamp(180px,var(--explain-files-width,272px),30%)] shrink-0 flex-col gap-3 pb-2 max-[1100px]:w-[clamp(180px,var(--explain-files-width,220px),30%)]"
      >
        <InputGroup className="mx-1 w-auto">
          <InputGroupAddon>
            <HugeiconsIcon icon={Search01Icon} size={14} />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Filter files"
            placeholder="Filter files"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </InputGroup>
        <nav
          aria-label="Snapshot files"
          className="min-h-0 flex-1 overflow-auto px-1"
        >
          <FileTree
            paths={snapshot.files
              .map((f) => f.path)
              .filter((p) => p.toLowerCase().includes(filter.toLowerCase()))}
            selected={path}
            marks={{}}
            statuses={capturedFileStatuses(snapshot.changes)}
            renderRow={(row, target) => (
              <FileMenu
                row={row}
                repositoryId={snapshot.repositoryId}
                path={target.path}
                onError={onError}
              />
            )}
            onSelect={setPath}
          />
        </nav>
        <SidebarResizeHandle
          name="Code Explain files"
          property="--explain-files-width"
          maxRatio={0.3}
        />
      </aside>
      <main className="flex min-w-0 flex-1 overflow-hidden rounded-panel border bg-card">
        {file && code !== null ? (
          <KnowledgeFile
            key={`${snapshot.repositoryId}/${path}/${hash}`}
            snapshot={snapshot}
            file={file}
            code={code}
          />
        ) : (
          <p role="status" className="p-6 text-sm text-muted-foreground">
            {file ? "Loading content…" : "No project files"}
          </p>
        )}
      </main>
    </div>
  )
}
