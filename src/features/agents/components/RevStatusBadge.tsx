import { cn } from "@/lib/utils"
import type { RevStatus } from "../hooks/useRevStatus"

/** Title-bar agent state: "● Rev ready". Harness details live in Settings. */
export function RevStatusBadge({
  status,
  className,
}: {
  status: RevStatus
  className?: string
}) {
  return (
    <span
      role="status"
      title={status.harness?.message}
      className={cn(
        "inline-flex h-[26px] items-center gap-1.5 rounded-full px-2.5 text-xs",
        className
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full",
          status.state === "ready" && "bg-review-validated",
          status.state !== "ready" &&
            status.state !== "checking" &&
            "bg-review-attention",
          status.state === "checking" && "bg-muted-foreground"
        )}
      />
      <span className="font-medium">Rev</span>
      <span className="text-muted-foreground">{status.state}</span>
    </span>
  )
}
