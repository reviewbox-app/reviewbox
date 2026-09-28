"use client"

import { useEffect, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Alert02Icon,
  ArrowDown01Icon,
  DashedLineCircleIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Spinner } from "@/components/ui/spinner"
import type { Workspace } from "@/lib/desktop/contracts.generated"
import { cn } from "@/lib/utils"
import { PreparationProgress } from "../components/PreparationProgress"
import { useReviewPreparation } from "../hooks/useReviewPreparation"

type RowState = "done" | "busy" | "todo" | "failed"

function Row({
  state,
  title,
  detail,
  children,
}: {
  state: RowState
  title: string
  detail?: string
  children?: React.ReactNode
}) {
  return (
    <li className="flex min-w-0 items-start gap-3 py-2.5">
      <span
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-full",
          state === "done" && "bg-review-validated-soft text-review-validated",
          state === "failed" && "bg-destructive/10 text-destructive"
        )}
      >
        {state === "busy" ? (
          <Spinner className="size-4" />
        ) : state === "done" ? (
          <HugeiconsIcon icon={Tick02Icon} size={14} />
        ) : state === "failed" ? (
          <HugeiconsIcon icon={Alert02Icon} size={14} />
        ) : (
          <HugeiconsIcon
            icon={DashedLineCircleIcon}
            size={18}
            className="text-muted-foreground"
          />
        )}
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <p
          className={cn(
            "text-sm font-medium",
            state === "todo" && "text-muted-foreground"
          )}
        >
          {title}
        </p>
        {detail && (
          <p className="mt-0.5 text-xs leading-4 wrap-anywhere text-muted-foreground">
            {detail}
          </p>
        )}
        {children}
      </div>
    </li>
  )
}

function duration(from: number, to: number) {
  const seconds = Math.max(0, Math.round((to - from) / 1000))
  return seconds < 60
    ? `${seconds} s`
    : `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, "0")} s`
}

/**
 * Rev prepares the review in front of the reader, then the review opens on its
 * first step. There is no step where proposals have to be accepted.
 */
export function PreparingReview({
  workspace,
  provider,
  onApplied,
  onStart,
  onLeave,
}: {
  workspace: Workspace
  provider: string
  /** Reloads the review once Rev's tour is saved. */
  onApplied: () => void | Promise<void>
  onStart: () => void
  /** Navigation detaches this screen; the native job stays alive. */
  onLeave: () => void
}) {
  const preparation = useReviewPreparation(workspace, provider, onApplied)
  const [details, setDetails] = useState(false)
  const { state, progress, active, cancel } = preparation
  const complete = state?.status === "ready"
  const failed =
    !!state && ["failed", "cancelled", "interrupted"].includes(state.status)
  const files = new Set(workspace.snapshot.changes.map((change) => change.path))
    .size
  const titles = state?.stepTitles ?? []
  const phases = [
    "context",
    "outline",
    "documents",
    "pseudocode",
    "checking",
  ] as const
  const phaseIndex = state
    ? phases.findIndex((phase) => phase === state.phase)
    : 0
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && active) {
        event.preventDefault()
        cancel()
      } else if (
        event.key === "Enter" &&
        preparation.readyToOpen &&
        !event.metaKey
      ) {
        event.preventDefault()
        onStart()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [active, cancel, preparation.readyToOpen, onStart])
  const rows = (
    <ol className="divide-y rounded-3xl border px-4" aria-label="Rev’s work">
      {[
        "Preparing the captured context",
        "Understanding the changes",
        "Writing the reading path",
        "Preparing pseudo-code",
        "Verifying and saving the review",
      ].map((title, index) => {
        const isPseudo = phases[index] === "pseudocode"
        const selection = state?.translationSelection
        const counts = state?.phases?.find(
          (item) => item.phase === phases[index]
        )
        const working = state?.activeBatches?.some(
          (item) => item.phase === phases[index]
        )
        const rowState: RowState =
          complete || (isPseudo && selection?.selectedFiles === 0)
            ? "done"
            : counts
              ? counts.total > 0 && counts.completed === counts.total
                ? "done"
                : failed && working
                  ? "failed"
                  : working
                    ? "busy"
                    : "todo"
              : index < phaseIndex
                ? "done"
                : index === phaseIndex
                  ? failed
                    ? "failed"
                    : "busy"
                  : "todo"
        return (
          <Row
            key={title}
            title={title}
            state={rowState}
            detail={
              isPseudo
                ? selection
                  ? `${selection.selectedFiles} ${selection.selectedFiles === 1 ? "file" : "files"} selected by Rev · ${selection.skippedFiles} do not need pseudo-code${counts && counts.total > 0 ? ` · ${counts.completed} of ${counts.total} versions ready` : ""}`
                  : "Rev will choose which files need a translation."
                : counts
                  ? `${counts.completed} of ${counts.total} results ready`
                  : index === phaseIndex
                    ? preparation.status
                    : undefined
            }
          />
        )
      })}
    </ol>
  )

  return (
    <main
      className="relative mx-2 mb-2 flex min-h-0 flex-1 overflow-hidden rounded-panel border bg-card"
      data-testid="preparing-review"
      aria-label="Review preparation"
    >
      <div className="absolute inset-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-[640px] space-y-6 px-8 py-16">
          {complete ? (
            <>
              <div className="space-y-3">
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
                    className={cn(
                      "transition-transform",
                      !details && "-rotate-90"
                    )}
                  />
                </button>
                {details && (
                  <div className="space-y-3">
                    {rows}
                    {progress && (
                      <PreparationProgress
                        key={progress.runId}
                        progress={progress}
                        batches={state?.activeBatches}
                        showDraft={state?.provider !== "codex"}
                        complete
                        checking={false}
                        status={preparation.status}
                      />
                    )}
                  </div>
                )}
              </div>
              <div className="flex size-12 items-center justify-center rounded-2xl bg-review-validated-soft text-review-validated">
                <HugeiconsIcon icon={Tick02Icon} size={24} />
              </div>
              <div className="space-y-3">
                <h1 className="text-3xl leading-10 font-semibold tracking-tight">
                  Your review is ready
                </h1>
                <p className="text-base leading-7 text-muted-foreground">
                  {titles.length
                    ? `Rev explained the changes in ${titles.length} ${titles.length === 1 ? "step" : "steps"}. Read them one at a time; the code is there when you need it.`
                    : "Rev did not create a guided tour for these changes. You can review the captured files manually."}
                </p>
              </div>
              <ol
                className="space-y-0.5 rounded-3xl border p-2"
                aria-label="Steps of the review"
              >
                {titles.map((title, index) => (
                  <li
                    key={index}
                    className="flex items-center gap-3 rounded-xl px-2 py-1.5 text-sm"
                  >
                    <span className="flex size-5.5 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-medium text-muted-foreground">
                      {index + 1}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{title}</span>
                  </li>
                ))}
              </ol>
              {preparation.error && (
                <p role="alert" className="text-sm text-destructive">
                  {preparation.error}
                </p>
              )}
              <div className="flex items-center gap-2 pt-2">
                <Button
                  size="lg"
                  onClick={onStart}
                  disabled={!preparation.readyToOpen}
                  autoFocus
                >
                  {titles.length ? "Start review" : "Review files"}
                </Button>
                {preparation.readyToOpen ? (
                  <Kbd>↵</Kbd>
                ) : (
                  <span role="status" className="text-xs text-muted-foreground">
                    Loading the prepared review…
                  </span>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="space-y-3">
                <p className="text-sm font-medium text-muted-foreground">
                  {workspace.review.title} · {files}{" "}
                  {files === 1 ? "file" : "files"}
                </p>
                <h1 className="text-3xl leading-10 font-semibold tracking-tight">
                  {failed
                    ? "Rev could not finish"
                    : "Rev is preparing your review"}
                </h1>
                <p className="text-base leading-7 text-muted-foreground">
                  Rev reads the changes and writes a tour that explains them,
                  step by step. You can browse elsewhere in the app while Rev
                  works. Quitting the app stops preparation; you can resume it
                  explicitly when you return.
                </p>
              </div>
              {rows}
              {state && (
                <p className="text-xs text-muted-foreground">
                  {state.completedBatches} of {state.totalBatches} batches
                  complete
                </p>
              )}
              {titles.length > 0 && (
                <ul
                  aria-label="Prepared outline"
                  className="space-y-1 text-sm text-muted-foreground"
                >
                  {titles.map((title, index) => (
                    <li key={index}>
                      {index + 1}. {title}
                    </li>
                  ))}
                </ul>
              )}
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
              {(state?.status === "cancelled" ||
                state?.status === "interrupted") && (
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
                  batches={state?.activeBatches}
                  showDraft={state?.provider !== "codex"}
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
                  Continue browsing
                </Button>
                {active ? (
                  <Button
                    variant="ghost"
                    disabled={preparation.pending}
                    onClick={cancel}
                  >
                    Cancel <Kbd>Esc</Kbd>
                  </Button>
                ) : failed || preparation.error ? (
                  <Button
                    variant="secondary"
                    disabled={preparation.pending}
                    onClick={() => void preparation.start()}
                  >
                    {state?.canResume ? "Resume preparation" : "Try again"}
                  </Button>
                ) : null}
              </div>
            </>
          )}
        </div>
      </div>
    </main>
  )
}
