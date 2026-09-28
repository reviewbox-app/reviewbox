import { useState } from "react"
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
import type { ReadingLevel, Workspace } from "@/lib/desktop/contracts.generated"
import { fileDecision, pseudoAvailable } from "../helpers/review.helpers"

/** The review files as the same tree as Code Explain. */
export function ReviewFiles({
  workspace,
  selectedId,
  level,
  onSelect,
}: {
  workspace: Workspace
  selectedId: string | null
  level: ReadingLevel
  onSelect: (fileId: string) => void
}) {
  const [filter, setFilter] = useState("")
  const { review, snapshot } = workspace
  const paths = review.files
    .map((file) => file.path)
    .filter((path) => path.toLowerCase().includes(filter.toLowerCase()))
  const marks: Record<string, FileMark> = {}
  for (const file of review.files) {
    if (fileDecision(review, file.id)) marks[file.path] = "validated"
    else if (level === "intermediate" && !pseudoAvailable(file, snapshot))
      marks[file.path] = "unavailable"
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
      <nav aria-label="Review files" className="min-h-0 flex-1 overflow-auto">
        <FileTree
          paths={paths}
          selected={
            review.files.find((file) => file.id === selectedId)?.path ?? ""
          }
          marks={marks}
          onSelect={(path) => {
            const file = review.files.find((item) => item.path === path)
            if (file) onSelect(file.id)
          }}
        />
      </nav>
    </div>
  )
}
