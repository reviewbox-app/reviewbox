"use client"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { MarkdownRenderer } from "@/features/markdown/components/MarkdownRenderer"
import { Alert02Icon, Tick02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useEffect, useRef, useState } from "react"
import {
  activityLabels,
  followsProgress,
  groupProgress,
  groupStatus,
  type PreparationProgress as Progress,
} from "../helpers/preparationProgress.helpers"

function ProgressMark({ status }: { status: string }) {
  if (status === "inProgress") return <Spinner className="size-3.5" />
  if (status === "completed")
    return <HugeiconsIcon icon={Tick02Icon} size={14} />
  if (status === "failed") return <HugeiconsIcon icon={Alert02Icon} size={14} />
  return <span className="size-2.5 rounded-full border border-current" />
}

function Elapsed({ progress }: { progress: Progress }) {
  const [now, setNow] = useState(progress.startedAt)
  useEffect(() => {
    if (progress.endedAt) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [progress.endedAt])
  const seconds = Math.max(
    0,
    Math.floor(((progress.endedAt ?? now) - progress.startedAt) / 1000)
  )
  return (
    <span
      className="text-xs text-muted-foreground tabular-nums"
      aria-label="Elapsed time"
    >
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")} elapsed
    </span>
  )
}

const statusLabels = {
  inProgress: "In progress",
  completed: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
  pending: "Upcoming",
}

export function PreparationProgress({
  progress,
  complete,
  checking,
  status,
}: {
  progress: Progress
  complete: boolean
  checking: boolean
  status: string
}) {
  const [expanded, setExpanded] = useState(false)
  const scroll = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const open = !complete || expanded
  const groups = groupProgress(progress.entries)
  const currentStep = progress.plan.find((step) => step.status === "inProgress")
  const currentActivity = [...groups]
    .reverse()
    .find((entry) => entry.type === "group" && entry.counts.inProgress)
  const headline = checking
    ? "Checking anchors against the review files…"
    : progress.outcome === "failed"
      ? "Preparation could not finish."
      : progress.outcome === "cancelled"
        ? "Preparation stopped."
        : complete
          ? "Suggestions ready for your review."
          : progress.draft
            ? "Writing suggested topics…"
            : (currentStep?.text ??
              (currentActivity?.type === "group"
                ? activityLabels[currentActivity.category]
                : progress.entries.length
                  ? "Rev is working. New activity will appear below."
                  : status))

  useEffect(() => {
    if (open && following.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight
  }, [progress, open])

  return (
    <section
      className="overflow-hidden rounded-3xl border bg-background/50"
      aria-label="Rev activity"
      data-testid="preparation-progress"
    >
      <header className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
        <div className="flex items-center justify-start gap-3">
          <h3 className="text-sm font-medium">Rev activity</h3>
          <Elapsed progress={progress} />
        </div>
        {complete && (
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={open}
            aria-controls="rev-progress-content"
            onClick={() => setExpanded((value) => !value)}
          >
            {open ? "Hide activity" : "Show activity"}
          </Button>
        )}
      </header>
      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="px-4 pb-3 text-sm text-muted-foreground"
      >
        {headline}
      </p>
      {open && (
        <div
          id="rev-progress-content"
          ref={scroll}
          tabIndex={0}
          aria-label="Preparation activity history"
          onScroll={(event) => {
            following.current = followsProgress(event.currentTarget)
          }}
          className="max-h-96 space-y-4 overflow-y-auto border-t px-4 py-3"
        >
          {progress.plan.length > 0 && (
            <section aria-label="Preparation plan" className="space-y-2">
              <h4 className="text-xs font-medium text-muted-foreground">
                Plan
              </h4>
              <ol className="space-y-2">
                {progress.plan.map((step, index) => {
                  const state =
                    progress.outcome && step.status === "inProgress"
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
          )}
          {progress.omitted > 0 && (
            <p className="text-xs text-muted-foreground">
              {progress.omitted} earlier activities omitted.
            </p>
          )}
          <ol className="space-y-3" aria-label="Activities">
            {groups.map((entry) =>
              entry.type === "message" ? (
                <li key={entry.id} className="border-l-2 pl-3">
                  <MarkdownRenderer allowHtml={false}>
                    {entry.text}
                  </MarkdownRenderer>
                </li>
              ) : (
                <li
                  key={entry.id}
                  className="flex items-start gap-2 text-sm"
                  data-activity-state={groupStatus(entry)}
                >
                  <span
                    aria-hidden="true"
                    className="flex h-5 w-4 shrink-0 items-center justify-center text-muted-foreground"
                  >
                    <ProgressMark status={groupStatus(entry)} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p>
                      {activityLabels[entry.category]}
                      {entry.count > 1 ? ` · ${entry.count} actions` : ""}
                    </p>
                    <p className="text-xs leading-5 text-muted-foreground">
                      {Object.entries(entry.counts)
                        .filter(([, count]) => count > 0)
                        .map(
                          ([state, count]) =>
                            `${entry.count > 1 ? `${count} ` : ""}${statusLabels[state as keyof typeof statusLabels]}`
                        )
                        .join(" · ")}
                    </p>
                  </div>
                </li>
              )
            )}
          </ol>
          {progress.draft && (
            <section
              aria-label="Suggestion draft"
              className="space-y-2 rounded-2xl bg-muted/50 p-3"
            >
              <h4 className="text-sm font-medium">
                {progress.outcome ? "Suggestion draft" : "Writing suggestions"}
              </h4>
              <p className="text-xs text-muted-foreground tabular-nums">
                {progress.draft.characters.toLocaleString()} characters received
                · {progress.draft.topics.length}{" "}
                {progress.draft.topics.length === 1 ? "topic" : "topics"}{" "}
                drafted
              </p>
              {progress.draft.topics.length > 0 && (
                <ul className="space-y-1 text-sm">
                  {progress.draft.topics.map((title, index) => (
                    <li key={index} className="wrap-anywhere">
                      {index + 1}. {title}
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-muted-foreground">
                Draft titles appear as they arrive. Topics and anchors are
                checked when the full response is ready.
              </p>
            </section>
          )}
          {!progress.outcome && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner className="size-3" />
              Work in progress. New activity will appear here.
            </p>
          )}
        </div>
      )}
    </section>
  )
}
