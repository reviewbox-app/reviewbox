"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Alert02Icon, Tick02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import type {
  Review,
  ReviewAction,
  ReviewFinalizationStep,
} from "@/lib/desktop/contracts.generated"
import type { ReviewFinalizationSession } from "../hooks/useReviewFinalization"
import { errorMessage } from "@/lib/desktop/review.commands"

const labels: Record<ReviewFinalizationStep["status"], string> = {
  queued: "Waiting",
  running: "In progress",
  completed: "Done",
  skipped: "Not needed",
  failed: "Failed",
}

function duration(step: ReviewFinalizationStep, now: number) {
  if (!step.startedAt) return null
  const start = Number(step.startedAt)
  const end = step.finishedAt ? Number(step.finishedAt) : now
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  const seconds = Math.max(0, Math.floor((end - start) / 1000))
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export function ReviewFinalization({
  review,
  session,
  starting = false,
  onAction,
}: {
  review: Review
  session?: ReviewFinalizationSession
  starting?: boolean
  onAction: (action: ReviewAction) => void
}) {
  const operation = session?.operation
  const active = starting || session?.active
  const [now, setNow] = useState(Date.now)
  const [copyMessage, setCopyMessage] = useState("")
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  if (!operation && !active && !session?.error && !session?.checking)
    return null
  const error = session?.error || operation?.error?.message
  const errorDetails = [
    session?.error,
    ...[operation?.error, ...(operation?.steps.map((step) => step.error) ?? [])]
      .filter((item) => !!item)
      .map((item) =>
        [item.code, item.message, item.details, item.diagnosticId]
          .filter(Boolean)
          .join("\n")
      ),
  ]
    .filter(Boolean)
    .join("\n\n")
  const warnings = operation?.steps.some((step) => step.status === "failed")
  const needsRetry =
    !!error ||
    operation?.status === "failed" ||
    operation?.status === "interrupted"
  const saved =
    !!review.publication.completion ||
    operation?.steps.some(
      (step) => step.id === "save" && step.status === "completed"
    )
  return (
    <section
      className="space-y-4 rounded-3xl border bg-background/50 p-4"
      aria-label="Review finalization"
    >
      <div
        className="flex items-center gap-2 text-sm font-medium"
        role="status"
        aria-live="polite"
      >
        {(active || session?.checking) && <Spinner className="size-4" />}
        <span>
          {session?.checking
            ? "Checking finalization status…"
            : active
              ? "Finalizing review…"
              : needsRetry
                ? "Finalization needs attention"
                : warnings
                  ? "Finalization finished with warnings"
                  : "Finalization finished"}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        {session?.checking
          ? "Restoring the saved finalization state."
          : saved
            ? "Your review decision is saved."
            : active
              ? "Saving your final review decision…"
              : "Your final decision has not been confirmed as saved."}
        {active && " You can leave this screen while the review finishes."}
      </p>
      {operation && (
        <ol className="space-y-3" aria-label="Finalization steps">
          {operation.steps.map((step) => (
            <li key={step.id} className="space-y-1">
              <div className="flex items-center gap-2 text-sm">
                {step.status === "running" && operation.status === "running" ? (
                  <Spinner className="size-3.5" />
                ) : step.status === "completed" ? (
                  <HugeiconsIcon icon={Tick02Icon} size={14} />
                ) : step.status === "failed" ? (
                  <HugeiconsIcon icon={Alert02Icon} size={14} />
                ) : (
                  <span className="mx-0.5 size-2.5 rounded-full border" />
                )}
                <span className="min-w-0 flex-1">{step.title}</span>
                <span className="text-xs text-muted-foreground">
                  {step.status === "running" && operation.status !== "running"
                    ? "Interrupted"
                    : labels[step.status]}
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {duration(step, now)}
                </span>
              </div>
              {step.error && (
                <p className="pl-5 text-xs text-destructive">
                  {step.error.message}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {needsRetry && session?.retryAction && (
        <Button
          size="sm"
          variant="secondary"
          disabled={!!active}
          onClick={() => {
            if (session.retryAction) onAction(session.retryAction)
          }}
        >
          Retry finalization
        </Button>
      )}
      {errorDetails && (
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(errorDetails)
              setCopyMessage("Error details copied.")
            } catch (cause) {
              setCopyMessage(
                `Could not copy error details: ${errorMessage(cause)}`
              )
            }
          }}
        >
          Copy error details
        </Button>
      )}
      {copyMessage && (
        <p className="text-xs text-muted-foreground" role="status">
          {copyMessage}
        </p>
      )}
    </section>
  )
}
