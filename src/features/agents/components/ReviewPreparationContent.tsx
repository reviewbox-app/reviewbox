"use client"

import { Button } from "@/components/ui/button"
import { InlineMarkdown } from "@/features/markdown/components/InlineMarkdown"
import type { Workspace } from "@/lib/desktop/contracts.generated"
import { Alert02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import type {
  ReviewPreparationView,
  ReviewUpdateView,
} from "../contracts/preparation.types"
import { PreparationPhases } from "./PreparationPhases"
import { PreparationWorkers } from "./PreparationWorkers"
import { PreparationProgress } from "./PreparationProgress"
import { PreparationSteps } from "./PreparationSteps"
import { PreparedReview } from "./PreparedReview"

export function ReviewPreparationContent({
  workspace,
  preparation,
  onStart,
  onLeave,
  updating = false,
  onDiscard,
  autoFocusStart = true,
  reviewStatus,
}: {
  workspace: Workspace
  preparation: ReviewPreparationView
  onStart: () => void
  onLeave: () => void
  updating?: boolean
  autoFocusStart?: boolean
  onDiscard?: () => void
  reviewStatus?: ReviewUpdateView
}) {
  const { state, progress, active, cancel } = preparation
  const failed =
    !!state && ["failed", "cancelled", "interrupted"].includes(state.status)
  const complete =
    state?.status === "ready" ||
    (!!reviewStatus && !active && !preparation.pending && !failed)
  const files = new Set(workspace.snapshot.changes.map((change) => change.path))
    .size
  const stopped =
    state?.status === "cancelled" || state?.status === "interrupted"
  const canDiscard = updating && failed && !!onDiscard
  const canRetry = !active && (failed || !!preparation.error)
  let title = updating
    ? "Rev is updating your review"
    : "Rev is preparing your review"
  if (failed) title = "Rev could not finish"

  if (complete) {
    return (
      <PreparedReview
        workspace={workspace}
        preparation={preparation}
        reviewStatus={reviewStatus}
        updating={updating}
        autoFocusStart={autoFocusStart}
        onStart={onStart}
      />
    )
  }

  return (
    <div className="mx-auto w-full max-w-[640px] space-y-6 p-6">
      <div className="space-y-3">
        <p className="text-sm font-medium text-muted-foreground">
          <InlineMarkdown>{workspace.review.title}</InlineMarkdown> · {files}{" "}
          {files === 1 ? "file" : "files"}
        </p>
        <h1 className="text-3xl leading-10 font-semibold tracking-tight">
          {title}
        </h1>
        <p className="text-base leading-7 text-muted-foreground">
          Rev reads the changes and writes a tour that explains them, step by
          step. You can browse elsewhere in the app while Rev works. Quitting
          the app stops preparation; you can resume it explicitly when you
          return.
        </p>
      </div>
      {state?.adaptation && (
        <p className="text-sm text-muted-foreground">
          {state.adaptation.retainedSteps} steps reused ·{" "}
          {state.adaptation.rewrittenSteps} to rewrite ·{" "}
          {state.adaptation.addedSteps} added · {state.adaptation.removedSteps}{" "}
          removed
        </p>
      )}
      <PreparationPhases preparation={preparation} failed={failed} />
      {state && (
        <p className="text-xs text-muted-foreground">
          {state.completedBatches} of {state.totalBatches} batches complete
        </p>
      )}
      {progress && (
        <PreparationWorkers
          progress={progress}
          batches={state?.activeBatches}
        />
      )}
      {state && <PreparationSteps steps={state.steps} status={state.status} />}
      {preparation.error && (
        <div
          role="alert"
          className="flex gap-2.5 rounded-2xl bg-destructive/10 p-4 text-sm text-destructive"
        >
          <HugeiconsIcon
            icon={Alert02Icon}
            size={16}
            className="mt-0.5 shrink-0"
          />
          <p className="min-w-0 wrap-anywhere">{preparation.error}</p>
        </div>
      )}
      {stopped && (
        <p role="status" className="text-sm text-muted-foreground">
          {active
            ? "Stopping the harness…"
            : "Preparation stopped. The review files are kept."}
        </p>
      )}
      {progress && (
        <PreparationProgress
          key={progress.runId}
          progress={progress}
          showDraft={false}
          complete={false}
          checking={state?.phase === "checking"}
          status={preparation.status}
        />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          Rev never changes your files.
        </p>
        <Button variant="ghost" onClick={onLeave}>
          {updating ? "Close" : "Continue browsing"}
        </Button>
        {canDiscard && (
          <Button
            variant="ghost"
            disabled={preparation.pending}
            onClick={onDiscard}
          >
            Discard update
          </Button>
        )}
        {active && (
          <Button
            variant="ghost"
            disabled={preparation.pending}
            onClick={cancel}
          >
            Cancel
          </Button>
        )}
        {canRetry && (
          <Button
            variant="secondary"
            disabled={preparation.pending}
            onClick={() => void preparation.start()}
          >
            {state?.canResume ? "Resume preparation" : "Try again"}
          </Button>
        )}
      </div>
    </div>
  )
}
