import { useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Menu01Icon } from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { ReviewSteps, type ReviewStepsProps } from "./ReviewSteps"
import { Hint } from "./Hint"

export function ReviewContents({ units, states, onSelect }: ReviewStepsProps) {
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
        <ReviewSteps
          className="max-h-[60vh]"
          units={units}
          states={states}
          onSelect={(unit) => {
            onSelect(unit)
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
