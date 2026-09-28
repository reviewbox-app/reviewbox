import { useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Menu01Icon, Tick02Icon } from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import type { ReadingUnit } from "../helpers/review.helpers"
import { Hint } from "./Hint"

export type UnitState = "validated" | "current" | "todo" | "stale"

export function ReviewContents({
  units,
  states,
  onSelect,
}: {
  units: ReadingUnit[]
  states: UnitState[]
  onSelect: (unit: ReadingUnit) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Hint label="Steps of the review">
        <PopoverTrigger
          render={<Button variant="ghost" aria-label="Contents" />}
        >
          <HugeiconsIcon icon={Menu01Icon} />
          <span className="max-[1100px]:hidden">Contents</span>
        </PopoverTrigger>
      </Hint>
      <PopoverContent
        align="end"
        className="w-[min(384px,calc(100vw-32px))] gap-1 p-2"
      >
        <div className="flex items-baseline justify-between px-2 pt-1 pb-2">
          <h2 className="text-sm font-medium">Contents</h2>
          <span className="text-xs text-muted-foreground">
            {units.length} steps
          </span>
        </div>
        {!units.length && (
          <p className="px-2 py-3 text-sm text-muted-foreground">
            This review has no guided steps.
          </p>
        )}
        <ol
          className="max-h-[60vh] space-y-0.5 overflow-y-auto"
          aria-label="Review steps"
        >
          {units.map((unit, index) => (
            <li key={unit.key}>
              <button
                type="button"
                aria-current={states[index] === "current" ? "step" : undefined}
                onClick={() => {
                  onSelect(unit)
                  setOpen(false)
                }}
                className={cn(
                  "flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left text-sm outline-none hover:bg-accent/60 focus-visible:ring-3 focus-visible:ring-ring/30",
                  states[index] === "current" && "bg-accent font-medium"
                )}
              >
                <span
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-full text-xs",
                    states[index] === "validated"
                      ? "bg-review-validated-soft text-review-validated"
                      : "bg-secondary text-muted-foreground"
                  )}
                >
                  {states[index] === "validated" ? (
                    <HugeiconsIcon icon={Tick02Icon} size={14} />
                  ) : (
                    index + 1
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {unit.step.step.title}
                </span>
                {states[index] === "stale" && (
                  <span className="text-xs text-review-attention">
                    Re-review
                  </span>
                )}
              </button>
            </li>
          ))}
        </ol>
      </PopoverContent>
    </Popover>
  )
}
