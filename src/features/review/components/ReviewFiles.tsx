import { useExplorerSearchMode } from "@/features/file-tree/hooks/useExplorerSearchMode"
import { FileMenu } from "@/features/file-tree/components/FileMenu"
import { useCallback, useLayoutEffect, useRef, useState } from "react"
import { useScrollEdgeMask } from "@/hooks/use-scroll-edge-mask"
import { FileTreeToolbar } from "@/features/file-tree/components/FileTreeToolbar"
import { FileTreeSearchResults } from "@/features/file-tree/components/FileTreeSearchResults"
import {
  useReviewContentSearch,
  type ReviewSearchMatch,
} from "../hooks/useReviewContentSearch"
import { useFileTreeNavigation } from "@/features/file-tree/hooks/useFileTreeNavigation"
import {
  FileTree,
  type FileMark,
} from "@/features/file-tree/components/FileTree"
import type { Workspace } from "@/lib/desktop/contracts.generated"
import { capturedFileStatuses } from "@/lib/git/file-status"
import { fileDecision, reviewedTreePaths } from "../helpers/review.helpers"

/** The review files as the same tree as Code Editor. */
export function ReviewFiles({
  workspace,
  selectedId,
  visible,
  onSelect,
  onMatch,
  onError,
}: {
  workspace: Workspace
  selectedId: string | null
  visible: boolean
  onError: (message: string) => void
  onSelect: (fileId: string) => void
  onMatch: (fileId: string, match: ReviewSearchMatch) => void
}) {
  const [filter, setFilter] = useState("")
  const [mode, setMode] = useExplorerSearchMode()
  const content = useReviewContentSearch(
    workspace,
    filter,
    !!filter.trim() && mode === "content"
  )
  const scrollMask = useScrollEdgeMask<HTMLElement>()
  const navigation = useFileTreeNavigation(
    workspace.snapshot.repositoryId,
    `review:${workspace.review.id}`,
    !!filter.trim()
  )
  const attachNavigation = navigation.ref
  const viewport = useRef<HTMLElement | null>(null)
  const attachViewport = useCallback(
    (node: HTMLElement | null) => {
      viewport.current = node
      attachNavigation(node)
      return scrollMask(node)
    },
    [scrollMask, attachNavigation]
  )
  const { review, snapshot } = workspace
  useLayoutEffect(() => {
    const container = viewport.current
    const selected = container?.querySelector('[aria-current="page"]')
    if (!visible || !container || !selected || !navigation.ready) return
    if (navigation.value.selectedPath === selected.getAttribute("title")) return
    const row = selected.getBoundingClientRect()
    const frame = container.getBoundingClientRect()
    container.scrollTo({
      top:
        container.scrollTop +
        row.top -
        frame.top +
        row.height / 2 -
        container.clientHeight / 2,
      behavior: "instant",
    })
    // Passive workspace refreshes must not reset a manually scrolled tree.
  }, [
    selectedId,
    visible,
    filter,
    snapshot.id,
    navigation.ready,
    navigation.value.selectedPath,
  ])
  const paths = review.files
    .map((file) => file.path)
    .filter((path) => path.toLowerCase().includes(filter.toLowerCase()))
  const marks: Record<string, FileMark> = {}
  for (const file of review.files) {
    if (fileDecision(review, file.id)) marks[file.path] = "validated"
  }
  return (
    <div className="flex h-full flex-col gap-2 p-2">
      <FileTreeToolbar
        value={filter}
        onChange={setFilter}
        mode={mode}
        onModeChange={setMode}
        paths={review.files.map((file) => file.path)}
        expandedPaths={navigation.value.expandedPaths}
        disabled={!!filter.trim() || !navigation.ready}
        onExpand={(expandedPaths) =>
          navigation.update((tree) => ({ ...tree, expandedPaths }))
        }
      />
      <nav
        ref={attachViewport}
        onScroll={navigation.onScroll}
        aria-label="Review files"
        className="min-h-0 flex-1 overflow-auto"
      >
        {filter.trim() && mode === "content" ? (
          <FileTreeSearchResults
            {...content}
            scopeLabel="Captured review files · before and after"
            onSelect={(match) => {
              const file = review.files.find((file) =>
                file.changeIds.includes(match.changeId)
              )
              if (file) onMatch(file.id, match)
            }}
          />
        ) : (
          <FileTree
            paths={paths}
            selected={
              review.files.find((file) => file.id === selectedId)?.path ?? ""
            }
            marks={marks}
            reviewedPaths={reviewedTreePaths(workspace)}
            statuses={capturedFileStatuses(snapshot.changes)}
            renderRow={(row, target) => (
              <FileMenu
                row={row}
                repositoryId={snapshot.repositoryId}
                path={target.path}
                onError={onError}
              />
            )}
            alwaysExpanded={!!filter.trim()}
            toggledFolders={new Set(navigation.value.expandedPaths)}
            onToggleFolder={navigation.toggle}
            onSelect={(path) => {
              navigation.update((tree) => ({ ...tree, selectedPath: path }))
              const file = review.files.find((item) => item.path === path)
              if (file) onSelect(file.id)
            }}
          />
        )}
      </nav>
    </div>
  )
}
