import { HugeiconsIcon } from "@hugeicons/react"
import { Tick02Icon } from "@hugeicons/core-free-icons"
import { cn } from "@/lib/utils"

export type WizardStep = "loading" | "rev" | "scope" | "preparation"

export function NewReviewStepper({
  step,
  setup,
}: {
  step: WizardStep
  setup: boolean
}) {
  const steps = [
    ...(setup ? [{ id: "rev", title: "Rev" }] : []),
    { id: "scope", title: "What to review" },
    { id: "preparation", title: "Preparation" },
  ]
  const current = steps.findIndex((s) => s.id === step)
  return (
    <ol
      aria-label="New review steps"
      className="flex min-w-0 items-center gap-3 max-[1000px]:gap-2"
    >
      {steps.map((item, index) => (
        <li
          key={item.id}
          aria-current={index === current ? "step" : undefined}
          className="flex min-w-0 items-center gap-3 max-[1000px]:gap-2"
        >
          {index > 0 && (
            <span aria-hidden className="h-px w-8 bg-border max-[1000px]:w-4" />
          )}
          <span
            className={cn(
              "flex size-5 shrink-0 items-center justify-center rounded-full border text-xs",
              index === current &&
                "border-primary bg-primary text-primary-foreground",
              index < current &&
                "border-transparent bg-primary/15 text-primary",
              index > current && "text-muted-foreground"
            )}
          >
            {index < current ? (
              <HugeiconsIcon icon={Tick02Icon} size={12} />
            ) : (
              index + 1
            )}
          </span>
          <span
            className={cn(
              "text-sm whitespace-nowrap",
              index !== current && "text-muted-foreground",
              index === current && "font-medium"
            )}
          >
            {item.title}
          </span>
        </li>
      ))}
    </ol>
  )
}
