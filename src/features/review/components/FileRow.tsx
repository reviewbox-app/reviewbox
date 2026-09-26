import type { Change } from "@/lib/desktop/contracts.generated"
import { cn } from "@/lib/utils"
import { changeLetter, fileName, folderOf } from "../helpers/review.helpers"

/** RB/File row: Git letter, file name, folder and passage count. */
export function FileRow({
  change,
  selected,
  onClick,
  className,
}: {
  change: Change
  selected?: boolean
  onClick?: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={change.path}
      className={cn(
        "flex w-full items-center gap-2 rounded-xl px-2 py-[5px] text-left outline-none hover:bg-accent/60 focus-visible:ring-3 focus-visible:ring-ring/30",
        selected && "bg-accent hover:bg-accent",
        className
      )}
    >
      <span className="flex size-[18px] shrink-0 items-center justify-center rounded-md bg-muted font-mono text-[11px] font-medium text-muted-foreground">
        {changeLetter(change)}
      </span>
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="truncate text-sm">{fileName(change.path)}</span>
        <span className="truncate text-xs text-muted-foreground">
          {folderOf(change.path)}
        </span>
      </span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {change.layer}
      </span>
    </button>
  )
}
