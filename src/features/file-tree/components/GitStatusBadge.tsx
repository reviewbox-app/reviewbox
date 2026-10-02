import { cn } from "@/lib/utils"
import type { GitFileStatus } from "@/lib/git/file-status"

const labels: Record<GitFileStatus, string> = {
  A: "Added",
  D: "Deleted",
  M: "Modified",
  R: "Renamed",
  U: "Untracked",
}

export function gitStatusColor(status?: GitFileStatus) {
  if (!status) return undefined
  return status === "D"
    ? "text-diff-removed"
    : status === "M"
      ? "text-git-modified"
      : "text-diff-added"
}

export function GitStatusBadge({
  status,
  className,
}: {
  status?: GitFileStatus
  className?: string
}) {
  if (!status) return null
  return (
    <span
      aria-label={labels[status]}
      title={labels[status]}
      data-git-status={status}
      className={cn(
        "w-3 shrink-0 text-center font-mono text-xs font-semibold",
        gitStatusColor(status),
        className
      )}
    >
      {status}
    </span>
  )
}
