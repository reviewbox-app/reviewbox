"use client"

import { Spinner } from "@/components/ui/spinner"
import { Alert02Icon, Tick02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import type { PreparationProgress as Progress } from "../helpers/preparationProgress.helpers"

function ProgressMark({ status }: { status: string }) {
  if (status === "inProgress") return <Spinner className="size-3.5" />
  if (status === "completed")
    return <HugeiconsIcon icon={Tick02Icon} size={14} />
  if (status === "failed") return <HugeiconsIcon icon={Alert02Icon} size={14} />
  return <span className="size-2.5 rounded-full border border-current" />
}

const statusLabels = {
  inProgress: "In progress",
  completed: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
  pending: "Upcoming",
}

export function PreparationWorkers({ progress }: { progress: Progress }) {
  return (
    <div className="space-y-4" aria-label="Delegated preparation work">
      {Object.values(progress.helpers).length > 0 && (
        <section aria-label="Delegated preparation work" className="space-y-2">
          <h4 className="text-xs font-medium text-muted-foreground">
            Helpers ·{" "}
            {
              Object.values(progress.helpers).filter(
                (helper) => helper.status === "inProgress"
              ).length
            }{" "}
            active
          </h4>
          <ul className="space-y-2 text-sm">
            {Object.values(progress.helpers).map((helper) => (
              <li key={helper.id} className="flex items-start gap-2">
                <ProgressMark status={helper.status} />
                <span className="min-w-0 flex-1">
                  {helper.task}
                  <span className="block text-xs text-muted-foreground">
                    {helper.model ?? "Model not reported"}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {statusLabels[helper.status]}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {Object.entries(progress.plans).map(([batch, plan]) => (
        <section
          key={batch}
          aria-label="Preparation plan"
          className="space-y-2"
        >
          <h4 className="text-xs font-medium text-muted-foreground">Plan</h4>
          <ol className="space-y-2">
            {plan.map((step, index) => {
              const state =
                (progress.outcome || progress.closedBatches.includes(batch)) &&
                step.status === "inProgress"
                  ? "interrupted"
                  : step.status
              return (
                <li key={index} className="flex items-start gap-2 text-sm">
                  <span
                    aria-hidden="true"
                    className="flex h-5 w-4 shrink-0 items-center justify-center text-muted-foreground"
                  >
                    <ProgressMark status={state} />
                  </span>
                  <span className="min-w-0 flex-1 wrap-anywhere">
                    {step.text}
                  </span>
                  <span className="shrink-0 text-xs leading-5 text-muted-foreground">
                    {progress.outcome && state === "pending"
                      ? "Not completed"
                      : statusLabels[state]}
                  </span>
                </li>
              )
            })}
          </ol>
        </section>
      ))}
    </div>
  )
}
