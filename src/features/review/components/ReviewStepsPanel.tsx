import { Cancel01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { Button } from "@/components/ui/button"
import { Hint } from "./Hint"
import { ReviewSteps, type ReviewStepsProps } from "./ReviewSteps"

export function ReviewStepsPanel({
  onClose,
  ...props
}: ReviewStepsProps & { onClose: () => void }) {
  return (
    <div className="flex h-full min-w-0 flex-col gap-2 p-2">
      <div className="flex h-8 shrink-0 items-center justify-between gap-2 px-2">
        <h2 className="truncate text-sm font-medium">Contents</h2>
        <Hint label="Hide review steps" side="right">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Hide review steps"
            onClick={onClose}
          >
            <HugeiconsIcon icon={Cancel01Icon} />
          </Button>
        </Hint>
      </div>
      <ReviewSteps {...props} />
    </div>
  )
}
