"use client"

import type { ReactElement, ReactNode } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Copy01Icon, FolderOpenIcon } from "@hugeicons/core-free-icons"
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/context-menu"
import { errorMessage } from "@/lib/desktop/review.commands"
import { fileTreeCommands } from "../services/file-tree.commands"

/** Shared path actions; Git mutations stay in the caller's optional sections. */
export function FileMenu({
  row,
  repositoryId,
  path,
  paths = [path],
  revealDisabled = false,
  onError,
  onOpenChange,
  before,
  after,
}: {
  row: ReactElement
  repositoryId: string
  path: string
  paths?: string[]
  revealDisabled?: boolean
  onError: (message: string) => void
  onOpenChange?: (open: boolean) => void
  before?: ReactNode
  after?: ReactNode
}) {
  const report = (work: Promise<unknown>) =>
    void work.catch((cause) => onError(errorMessage(cause)))
  return (
    <ContextMenu onOpenChange={onOpenChange}>
      <ContextMenuTrigger
        render={row}
        onKeyDown={(event) => {
          if (
            event.key !== "ContextMenu" &&
            !(event.shiftKey && event.key === "F10")
          )
            return
          event.preventDefault()
          const target = event.currentTarget
          const bounds = target.getBoundingClientRect()
          target.dispatchEvent(
            new MouseEvent("contextmenu", {
              bubbles: true,
              cancelable: true,
              button: 2,
              clientX: bounds.left + 20,
              clientY: bounds.top + bounds.height / 2,
            })
          )
        }}
      />
      <ContextMenuContent>
        {before}
        <ContextMenuItem
          onClick={() =>
            report(navigator.clipboard.writeText(paths.join("\n")))
          }
        >
          <HugeiconsIcon icon={Copy01Icon} />
          Copy {paths.length > 1 ? "paths" : "path"}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={revealDisabled}
          onClick={() => report(fileTreeCommands.reveal(repositoryId, path))}
        >
          <HugeiconsIcon icon={FolderOpenIcon} />
          Reveal in Finder
        </ContextMenuItem>
        {after}
      </ContextMenuContent>
    </ContextMenu>
  )
}
