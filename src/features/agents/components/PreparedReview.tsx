import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Spinner } from "@/components/ui/spinner"
import { InlineMarkdown } from "@/features/markdown/components/InlineMarkdown"
import type { Workspace } from "@/lib/desktop/contracts.generated"
import { cn } from "@/lib/utils"
import {
  Alert02Icon,
  ArrowDown01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useState } from "react"
import type {
  ReviewPreparationView,
  ReviewUpdateView,
} from "../contracts/preparation.types"
import { PreparationWorkers } from "./PreparationWorkers"
import { PreparationProgress } from "./PreparationProgress"
import { ReviewPreparationError } from "./ReviewPreparationError"
import { WorkingContextStatus } from "./WorkingContextStatus"

function duration(from: number, to: number) {
  const seconds = Math.max(0, Math.round((to - from) / 1000))
  return seconds < 60
    ? `${seconds} s`
    : `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, "0")} s`
}

function completedHeading(
  count: number,
  updating: boolean,
  reviewStatus?: ReviewUpdateView
) {
  if (reviewStatus?.checking) {
    return {
      title: "Checking your review",
      description: "Comparing the captured review with the current worktree…",
    }
  }
  if (reviewStatus?.needsUpdate) {
    return {
      title: "Your review needs an update",
      description:
        "The worktree has changed since this review was prepared. Update with Rev to adapt the reading path; your existing review remains available.",
    }
  }
  const title =
    reviewStatus || updating ? "Your review is updated" : "Your review is ready"
  const description = count
    ? `Rev explained the changes in ${count} ${count === 1 ? "step" : "steps"}. Read them one at a time; the code is there when you need it.`
    : "Rev did not create a guided tour for these changes. You can review the captured files manually."
  return { title, description }
}

function updateActions(status: ReviewUpdateView, onRead: () => void) {
  const updateFirst = !status.needsUpdate && !status.checking
  const read = {
    label: "Back to review",
    variant: updateFirst ? ("default" as const) : ("secondary" as const),
    disabled: false,
    onClick: onRead,
  }
  const update = {
    label: "Update with Rev",
    variant: updateFirst ? ("secondary" as const) : ("default" as const),
    disabled: status.busy || status.checking,
    onClick: status.onUpdate,
  }
  return updateFirst ? [update, read] : [read, update]
}

export function PreparedReview({
  workspace,
  preparation,
  reviewStatus,
  updating,
  autoFocusStart,
  onStart,
}: {
  workspace: Workspace
  preparation: ReviewPreparationView
  reviewStatus?: ReviewUpdateView
  updating: boolean
  autoFocusStart: boolean
  onStart: () => void
}) {
  const [details, setDetails] = useState(false)
  const { state, progress } = preparation
  const needsUpdate = !!reviewStatus?.needsUpdate
  const attention = needsUpdate || !!reviewStatus?.checking
  const showHistory = !attention && state?.status === "ready"
  const existingSteps =
    workspace.review.topics?.flatMap((topic) => topic.steps) ?? []
  const titles = existingSteps.length
    ? existingSteps.map((step) => step.title)
    : (state?.steps.map((step) => step.title) ?? [])
  const steps = titles.map((title, index) => ({
    title,
    stale: !!reviewStatus?.staleStepIds.includes(existingSteps[index]?.id),
  }))
  const heading = completedHeading(titles.length, updating, reviewStatus)
  const actions = reviewStatus ? updateActions(reviewStatus, onStart) : []
  let startLabel = titles.length ? "Start review" : "Review files"
  if (updating) startLabel = "Back to review"

  return (
    <div className="mx-auto w-full max-w-[640px] space-y-6 p-6">
      {showHistory && (
        <div className="space-y-3 pr-8">
          <button
            type="button"
            aria-expanded={details}
            onClick={() => setDetails(!details)}
            className="flex w-full items-center gap-2.5 rounded-2xl bg-muted/60 px-3 py-2 text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30"
          >
            <HugeiconsIcon
              icon={Tick02Icon}
              size={14}
              className="text-review-validated"
            />
            <span className="flex-1">
              Preparation finished
              {progress && state?.updatedAt
                ? ` in ${duration(progress.startedAt, Number(state.updatedAt))}`
                : ""}
            </span>
            Details
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              size={14}
              className={cn("transition-transform", !details && "-rotate-90")}
            />
          </button>
          {details && (
            <div className="space-y-3">
              {state?.adaptation && (
                <p className="text-sm text-muted-foreground">
                  {state.adaptation.retainedSteps} steps reused ·{" "}
                  {state.adaptation.rewrittenSteps} to rewrite ·{" "}
                  {state.adaptation.addedSteps} added ·{" "}
                  {state.adaptation.removedSteps} removed
                </p>
              )}
              {state && (
                <p className="text-xs text-muted-foreground">
                  {state.completedBatches} of {state.totalBatches} documents
                  complete
                </p>
              )}
              {progress && <PreparationWorkers progress={progress} />}
              {progress && (
                <PreparationProgress
                  key={progress.runId}
                  progress={progress}
                  showDraft={false}
                  complete
                  checking={false}
                  status={preparation.status}
                />
              )}
            </div>
          )}
        </div>
      )}
      <div
        className={cn(
          "flex size-12 items-center justify-center rounded-2xl",
          attention
            ? "bg-review-attention-soft text-review-attention"
            : "bg-review-validated-soft text-review-validated"
        )}
      >
        {reviewStatus?.checking ? (
          <Spinner />
        ) : (
          <HugeiconsIcon
            icon={needsUpdate ? Alert02Icon : Tick02Icon}
            size={24}
          />
        )}
      </div>
      <div className="space-y-3">
        <h1 className="text-3xl leading-10 font-semibold tracking-tight">
          {heading.title}
        </h1>
        <p className="text-base leading-7 text-muted-foreground">
          {heading.description}
        </p>
      </div>
      <ol
        className="space-y-0.5 rounded-3xl border p-2"
        aria-label="Steps of the review"
      >
        {steps.map(({ title, stale }, index) => (
          <li
            key={index}
            className={cn(
              "flex items-center gap-3 rounded-xl px-2 py-1.5 text-sm",
              stale && "opacity-60"
            )}
          >
            <span className="flex size-5.5 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-medium text-muted-foreground">
              {stale ? (
                <HugeiconsIcon
                  icon={Alert02Icon}
                  aria-label="Step needs update"
                  size={14}
                  className="text-review-attention"
                />
              ) : (
                index + 1
              )}
            </span>
            <span
              className={cn("min-w-0 flex-1 truncate", stale && "line-through")}
            >
              <InlineMarkdown>{title}</InlineMarkdown>
            </span>
          </li>
        ))}
      </ol>
      {reviewStatus && preparation.status && (
        <p role="status" className="text-sm text-muted-foreground">
          {preparation.status}
        </p>
      )}
      <ReviewPreparationError workspace={workspace} preparation={preparation} />
      <WorkingContextStatus
        repositoryId={workspace.review.repositoryId}
        reviewId={workspace.review.id}
        revision={workspace.review.revision}
      />
      {reviewStatus ? (
        <div
          className="flex items-center justify-end gap-2 pt-2"
          aria-label="Review update actions"
        >
          {actions.map((action) => (
            <Button
              key={action.label}
              variant={action.variant}
              disabled={action.disabled}
              onClick={action.onClick}
            >
              {action.label}
            </Button>
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-2 pt-2">
          <Button
            size="lg"
            onClick={onStart}
            disabled={!preparation.readyToOpen}
            autoFocus={autoFocusStart}
          >
            {startLabel}
          </Button>
          {preparation.readyToOpen ? (
            <Kbd>↵</Kbd>
          ) : (
            <span role="status" className="text-xs text-muted-foreground">
              Loading the prepared review…
            </span>
          )}
        </div>
      )}
    </div>
  )
}
