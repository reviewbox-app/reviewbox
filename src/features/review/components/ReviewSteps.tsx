import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { InlineMarkdown } from "@/features/markdown/components/InlineMarkdown"
import { useScrollEdgeMask } from "@/hooks/use-scroll-edge-mask"
import { cn } from "@/lib/utils"
import { Alert02Icon, Tick02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import type { ReadingUnit } from "../helpers/review.helpers"

export type UnitState = "validated" | "current" | "todo" | "stale"
export interface ReviewStepsProps {
  units: ReadingUnit[]
  states: UnitState[]
  onSelect: (unit: ReadingUnit) => void
  className?: string
}

export function ReviewSteps({
  units,
  states,
  onSelect,
  className,
}: ReviewStepsProps) {
  const scrollMask = useScrollEdgeMask<HTMLOListElement>()
  return (
    <ol
      ref={scrollMask}
      className={cn("min-h-0 space-y-0.5 overflow-y-auto", className)}
      aria-label="Review steps"
    >
      {units.map((unit, index) => (
        <li key={unit.key}>
          <Tooltip disableHoverablePopup>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-current={
                    states[index] === "current" ? "step" : undefined
                  }
                  onClick={() => {
                    onSelect(unit)
                  }}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-full p-2 text-left text-sm outline-none hover:bg-accent/60 focus-visible:ring-3 focus-visible:ring-ring/30",
                    states[index] === "current" && "bg-accent font-medium",
                    states[index] === "stale" && "opacity-60"
                  )}
                />
              }
            >
              <span
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full text-xs",
                  states[index] === "stale"
                    ? "bg-review-attention-soft text-review-attention"
                    : states[index] === "validated"
                      ? "bg-review-validated-soft text-review-validated"
                      : "bg-accent text-muted-foreground"
                )}
              >
                {states[index] === "stale" ? (
                  <HugeiconsIcon icon={Alert02Icon} size={14} />
                ) : states[index] === "validated" ? (
                  <HugeiconsIcon icon={Tick02Icon} size={14} />
                ) : (
                  index + 1
                )}
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1 truncate",
                  states[index] === "stale" && "line-through"
                )}
              >
                <InlineMarkdown>{unit.step.step.title}</InlineMarkdown>
              </span>
              {states[index] === "stale" && (
                <span className="text-xs text-review-attention">Re-review</span>
              )}
            </TooltipTrigger>
            <TooltipContent side="right" className="break-words">
              <span>
                <InlineMarkdown>{unit.step.step.title}</InlineMarkdown>
              </span>
            </TooltipContent>
          </Tooltip>
        </li>
      ))}
    </ol>
  )
}
