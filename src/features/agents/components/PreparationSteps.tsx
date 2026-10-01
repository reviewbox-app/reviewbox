"use client"

import { Spinner } from "@/components/ui/spinner"
import { InlineMarkdown } from "@/features/markdown/components/InlineMarkdown"
import type {
  PreparationState,
  PreparationStep,
} from "@/lib/desktop/contracts.generated"
import { cn } from "@/lib/utils"
import { Alert02Icon, PauseIcon, Tick02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

const labels = {
  queued: "Waiting for writing",
  writing: "Writing",
  checking: "Verifying",
  ready: "Ready",
  failed: "Could not finish",
  interrupted: "Paused",
}

export function PreparationSteps({
  steps,
  status,
}: {
  steps: PreparationStep[]
  status: PreparationState["status"]
}) {
  const ready = steps.filter((step) => step.status === "ready").length
  if (!steps.length) return null
  return (
    <section aria-label="Reading path preparation" className="space-y-2">
      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="text-xs text-muted-foreground"
      >
        {ready} of {steps.length} steps ready
      </p>
      <ol aria-label="Prepared outline" className="space-y-2 text-sm">
        {steps.map((step) => {
          const state =
            step.status === "ready" || status === "running"
              ? step.status
              : status === "failed"
                ? "failed"
                : "interrupted"
          const loading =
            state === "queued" || state === "writing" || state === "checking"
          return (
            <li
              key={step.id}
              data-step-id={step.id}
              data-state={state}
              className="flex min-w-0 items-start gap-2.5"
            >
              <span
                title={labels[state]}
                className={cn(
                  "mt-0.5 flex size-4 shrink-0 items-center justify-center",
                  state === "ready" && "text-review-validated",
                  state === "failed" && "text-destructive"
                )}
              >
                {loading ? (
                  <Spinner className="size-4" />
                ) : (
                  <HugeiconsIcon
                    icon={
                      state === "ready"
                        ? Tick02Icon
                        : state === "failed"
                          ? Alert02Icon
                          : PauseIcon
                    }
                    size={16}
                  />
                )}
              </span>
              <span className="sr-only">{labels[state]}: </span>
              <span
                className={cn(
                  "min-w-0 wrap-anywhere",
                  state === "ready" ? "opacity-100" : "opacity-60"
                )}
              >
                <InlineMarkdown>{step.title}</InlineMarkdown>
              </span>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
