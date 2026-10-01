import { useCallback, useLayoutEffect, useRef, useState } from "react"
import { useScrollEdgeMask } from "@/hooks/use-scroll-edge-mask"
import { HugeiconsIcon } from "@hugeicons/react"
import { Search01Icon } from "@hugeicons/core-free-icons"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import {
  FileTree,
  type FileMark,
} from "@/features/knowledge/components/FileTree"
import type { Workspace } from "@/lib/desktop/contracts.generated"
import { capturedFileStatuses } from "@/lib/git/file-status"
import { fileDecision, reviewedTreePaths } from "../helpers/review.helpers"

/** The review files as the same tree as Code Explain. */
export function ReviewFiles({
  workspace,
  selectedId,
  visible,
  onSelect,
}: {
  workspace: Workspace
  selectedId: string | null
  visible: boolean
  onSelect: (fileId: string) => void
}) {
  const [filter, setFilter] = useState("")
  const scrollMask = useScrollEdgeMask<HTMLElement>()
  const viewport = useRef<HTMLElement | null>(null)
  const attachViewport = useCallback(
    (node: HTMLElement | null) => {
      viewport.current = node
      return scrollMask(node)
    },
    [scrollMask]
  )
  const { review, snapshot } = workspace
  useLayoutEffect(() => {
    const container = viewport.current
    const selected = container?.querySelector('[aria-current="page"]')
    if (!visible || !container || !selected) return
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
  }, [selectedId, visible, filter, snapshot.id])
  const paths = review.files
    .map((file) => file.path)
    .filter((path) => path.toLowerCase().includes(filter.toLowerCase()))
  const marks: Record<string, FileMark> = {}
  for (const file of review.files) {
    if (fileDecision(review, file.id)) marks[file.path] = "validated"
  }
  return (
    <div className="flex h-full flex-col gap-2 p-2">
      <InputGroup className="w-auto">
        <InputGroupAddon>
          <HugeiconsIcon icon={Search01Icon} size={14} />
        </InputGroupAddon>
        <InputGroupInput
          aria-label="Filter files"
          placeholder={`Filter ${review.files.length} files`}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </InputGroup>
      <nav
        ref={attachViewport}
        aria-label="Review files"
        className="min-h-0 flex-1 overflow-auto"
      >
        <FileTree
          paths={paths}
          selected={
            review.files.find((file) => file.id === selectedId)?.path ?? ""
          }
          marks={marks}
          reviewedPaths={reviewedTreePaths(workspace)}
          statuses={capturedFileStatuses(snapshot.changes)}
          alwaysExpanded
          onSelect={(path) => {
            const file = review.files.find((item) => item.path === path)
            if (file) onSelect(file.id)
          }}
        />
      </nav>
    </div>
  )
}
