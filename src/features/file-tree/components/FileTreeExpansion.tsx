import { useMemo } from "react"
import { CollapseIcon, ExpandIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { buildTree, folderPaths } from "../helpers/tree.helpers"

export function FileTreeExpansion({
  paths,
  expandedPaths,
  onChange,
  disabled = false,
}: {
  paths: string[]
  expandedPaths: string[]
  onChange: (update: (paths: string[]) => string[]) => void
  disabled?: boolean
}) {
  const folders = useMemo(() => new Set(folderPaths(paths)), [paths])
  const roots = useMemo(() => [...buildTree(paths).folders.values()], [paths])
  // Hidden descendants and compacted-away parents do not make a visible folder open.
  const expanded = roots.some((folder) => expandedPaths.includes(folder.path))
  const label = expanded ? "Collapse all" : "Expand all"
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className="size-4 shrink-0 rounded-sm p-0"
            aria-label={label}
            disabled={disabled || !folders.size}
            onClick={() =>
              onChange((current) =>
                expanded
                  ? current.filter((path) => !folders.has(path))
                  : [...new Set([...current, ...folders])]
              )
            }
          />
        }
      >
        <HugeiconsIcon
          icon={expanded ? CollapseIcon : ExpandIcon}
          className="size-3"
        />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
