import type { Coverage } from "@/lib/desktop/contracts.generated"
import { cn } from "@/lib/utils"

/** Split of the snapshot's passages; `examined` already includes validated ones. */
export function coverageSegments(coverage: Coverage | null) {
  if (!coverage?.total) return []
  const validated = coverage.validated
  const reviewed = Math.max(coverage.examined - validated, 0)
  const outside = coverage.outside
  const inTopic = Math.max(coverage.total - validated - reviewed - outside, 0)
  return [
    {
      key: "validated",
      label: "Validated",
      value: validated,
      className: "bg-review-validated",
    },
    {
      key: "reviewed",
      label: "Reviewed",
      value: reviewed,
      className: "bg-primary",
    },
    {
      key: "topic",
      label: "Unread in a topic",
      value: inTopic,
      className: "bg-muted-foreground/60",
    },
    {
      key: "outside",
      label: "Outside the tour",
      value: outside,
      className: "bg-muted",
    },
  ].filter((segment) => segment.value > 0)
}

/** Thin segmented coverage bar; never a chart. */
export function CoverageBar({
  coverage,
  className,
}: {
  coverage: Coverage | null
  className?: string
}) {
  const segments = coverageSegments(coverage)
  return (
    <div
      role="img"
      aria-label={segments.map((s) => `${s.value} ${s.label}`).join(", ")}
      className={cn("flex h-1 gap-0.5", className)}
    >
      {segments.length === 0 && (
        <span className="flex-1 rounded-full bg-muted" />
      )}
      {segments.map((segment) => (
        <span
          key={segment.key}
          className={cn(
            "rounded-full transition-[flex-grow]",
            segment.className
          )}
          style={{ flexGrow: segment.value }}
        />
      ))}
    </div>
  )
}
