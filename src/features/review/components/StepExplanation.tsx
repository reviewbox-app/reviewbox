import { HugeiconsIcon } from "@hugeicons/react"
import {
  Alert02Icon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  CodeIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { ReviewStatus, type ReadingStatus } from "./ReviewStatus"

/** Explanation tab: where the step sits, what it says and the evidence around it. */
export function StepExplanation({
  position,
  title,
  status,
  anchor,
  explanation,
  brief,
  validation,
  onStep,
  children,
}: {
  /** "Step 2 of 4 · Invalidate changed passages" or "Outside the tour". */
  position: string
  title: string
  status: ReadingStatus
  anchor: string | null
  explanation: string
  brief?: string
  /** "Validated by Reviewer · Sep 24" when a current decision exists. */
  validation?: string
  onStep: (direction: number) => void
  children?: React.ReactNode
}) {
  return (
    <div className="space-y-5">
      <div className="-my-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="truncate">{position}</span>
        <span className="flex">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Previous step (K)"
            onClick={() => onStep(-1)}
          >
            <HugeiconsIcon icon={ArrowUp01Icon} size={14} />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Next step (J)"
            onClick={() => onStep(1)}
          >
            <HugeiconsIcon icon={ArrowDown01Icon} size={14} />
          </Button>
        </span>
      </div>
      <div className="space-y-3">
        <h2 className="flex items-start gap-2.5 text-lg leading-7 font-medium">
          <span className="flex h-7 items-center">
            <ReviewStatus status={status} />
          </span>
          {title}
        </h2>
        <div className="flex flex-wrap gap-1.5">
          {anchor && (
            <Badge variant="secondary">
              <HugeiconsIcon icon={CodeIcon} />
              {anchor}
            </Badge>
          )}
          {validation && (
            <Badge className="bg-review-validated-soft text-review-validated">
              <HugeiconsIcon icon={Tick02Icon} />
              {validation}
            </Badge>
          )}
        </div>
      </div>
      {status === "Re-review" && (
        <div
          role="status"
          className="flex gap-2.5 rounded-2xl bg-review-attention-soft p-3 text-sm leading-5"
        >
          <HugeiconsIcon
            icon={Alert02Icon}
            size={16}
            className="mt-0.5 shrink-0 text-review-attention"
          />
          This anchor belongs to an older version. Edit the topic to attach it
          to the current passage; the previous decision stays in the history.
        </div>
      )}
      <p className="text-sm leading-6 whitespace-pre-wrap">{explanation}</p>
      {brief && (
        <Collapsible defaultOpen>
          <CollapsibleTrigger className="group/brief flex w-full items-center justify-between rounded-xl text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/30">
            Topic brief · goal, expected behavior, risks
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              size={16}
              className="-rotate-90 text-muted-foreground transition-transform group-data-[panel-open]/brief:rotate-0"
            />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <p className="mt-2 text-sm leading-6 whitespace-pre-wrap text-muted-foreground">
              {brief}
            </p>
          </CollapsibleContent>
        </Collapsible>
      )}
      {children}
    </div>
  )
}
