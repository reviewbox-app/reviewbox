"use client"
import { createPortal } from "react-dom"
import { HugeiconsIcon } from "@hugeicons/react"
import { CommentAdd01Icon } from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import type { SourceSelection } from "@/features/code-editor/contracts/sourceSelection.types"

export function ReviewCommentToolbar({
  selection,
  onComment,
  disabled,
}: {
  selection: SourceSelection
  onComment: () => void
  disabled: boolean
}) {
  return createPortal(
    <div
      role="toolbar"
      aria-label="Selection actions"
      className="fixed z-40 rounded-lg border bg-popover p-1 shadow-md"
      style={{
        left: Math.max(
          8,
          Math.min(selection.position.left, window.innerWidth - 160)
        ),
        top: Math.max(8, selection.position.top - 40),
      }}
    >
      <Button
        size="xs"
        variant="ghost"
        disabled={disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onComment}
      >
        <HugeiconsIcon icon={CommentAdd01Icon} /> Add comment
      </Button>
    </div>,
    document.body
  )
}
