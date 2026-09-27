import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Separator } from "@/components/ui/separator"
import { MarkdownRenderer } from "@/features/markdown/components/MarkdownRenderer"
import {
  Alert02Icon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  CodeIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
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
          <span className="min-w-0 wrap-anywhere">{title}</span>
        </h2>
        <div className="flex flex-wrap gap-1.5">
          {anchor && (
            <Badge
              variant="secondary"
              className="max-w-full wrap-anywhere whitespace-normal"
            >
              <HugeiconsIcon icon={CodeIcon} />
              {anchor}
            </Badge>
          )}
          {validation && (
            <Badge className="max-w-full bg-review-validated-soft whitespace-normal text-review-validated">
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
      <MarkdownRenderer>{explanation}</MarkdownRenderer>
      {brief && (
        <Collapsible>
          <CollapsibleTrigger className="group/brief mb-2 flex w-full items-center justify-between rounded-xl text-sm font-medium opacity-60 transition-all outline-none hover:opacity-100 focus-visible:ring-3 focus-visible:ring-ring/30">
            Topic brief · goal, expected behavior, risks
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              size={16}
              className="-rotate-90 text-muted-foreground transition-transform group-data-[panel-open]/brief:rotate-0"
            />
          </CollapsibleTrigger>
          <CollapsibleContent className="pl-3">
            <MarkdownRenderer className="leading-tight opacity-50">
              {brief}
            </MarkdownRenderer>
          </CollapsibleContent>
        </Collapsible>
      )}

      <Separator />

      {children}
    </div>
  )
}
