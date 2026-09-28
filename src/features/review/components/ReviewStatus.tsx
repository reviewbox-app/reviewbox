import { cn } from "@/lib/utils"

export type ReadingStatus =
  "Unread" | "In progress" | "Validated" | "Re-review" | "Uncovered"

/** 16px reading-state glyph (RB/Status); the label stays available to assistive tech. */
export function ReviewStatus({
  status,
  className,
}: {
  status: ReadingStatus | string
  className?: string
}) {
  return (
    <svg
      viewBox="0 0 16 16"
      role="img"
      aria-label={status}
      className={cn("size-4 shrink-0", className)}
    >
      <title>{status}</title>
      {status === "In progress" ? (
        <g className="text-primary">
          <circle
            cx="8"
            cy="8"
            r="5.25"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <circle cx="8" cy="8" r="3" fill="currentColor" />
        </g>
      ) : status === "Validated" ? (
        <g>
          <circle cx="8" cy="8" r="7" className="fill-review-validated" />
          <path
            d="M5.2 8.2 7.1 10l3.7-3.9"
            fill="none"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="stroke-background"
          />
        </g>
      ) : status === "Re-review" ? (
        <g>
          <circle cx="8" cy="8" r="7" className="fill-review-attention" />
          <text
            x="8"
            y="11.5"
            textAnchor="middle"
            fontSize="10"
            fontWeight="600"
            className="fill-background font-sans"
          >
            !
          </text>
        </g>
      ) : (
        <circle
          cx="8"
          cy="8"
          r="5.25"
          fill="none"
          strokeWidth="1.5"
          strokeDasharray={status === "Uncovered" ? "2.2 2.2" : undefined}
          className="stroke-muted-foreground"
        />
      )}
    </svg>
  )
}
