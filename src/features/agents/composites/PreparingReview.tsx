"use client"

import { useEffect, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  AiMagicIcon,
  Alert02Icon,
  ArrowRight01Icon,
  GitCommitIcon,
  PlusSignIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { Kbd } from "@/components/ui/kbd"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import type { Topic, Workspace } from "@/lib/desktop/contracts.generated"
import { cn } from "@/lib/utils"
import { PreparationProgress } from "../components/PreparationProgress"
import { PreparationTopicCard } from "../components/PreparationTopicCard"
import { PreparationTopicEditor } from "../components/PreparationTopicEditor"
import { groupFileAnchors } from "@/features/review/helpers/review.helpers"
import { outsidePreparation } from "../helpers/preparation.helpers"
import { useReviewPreparation } from "../hooks/useReviewPreparation"
import { harnessNames } from "../hooks/useRevStatus"

function SessionStep({
  title,
  detail,
  done,
  busy,
}: {
  title: string
  detail?: string
  done?: boolean
  busy?: boolean
}) {
  return (
    <li className="flex min-w-0 items-start gap-2.5">
      <span className="flex h-5 w-4 shrink-0 items-center justify-center">
        {busy ? (
          <Spinner className="size-4" />
        ) : done ? (
          <HugeiconsIcon
            icon={Tick02Icon}
            size={16}
            className="text-muted-foreground"
          />
        ) : (
          <span className="size-3 rounded-full border border-muted-foreground/60" />
        )}
      </span>
      <div className="min-w-0">
        <p
          className={cn(
            "text-sm leading-5",
            !done && !busy && "text-muted-foreground"
          )}
        >
          {title}
        </p>
        {detail && (
          <p className="mt-0.5 text-xs leading-4 wrap-anywhere text-muted-foreground">
            {detail}
          </p>
        )}
      </div>
    </li>
  )
}

export function PreparingReview({
  workspace,
  provider,
  onDone,
  onApplied,
}: {
  workspace: Workspace
  provider: string
  onDone: () => void
  onApplied: () => void | Promise<void>
}) {
  const preparation = useReviewPreparation(
    workspace,
    provider,
    onApplied,
    onDone
  )
  const [editing, setEditing] = useState<Topic | null>(null)
  const [showOutside, setShowOutside] = useState(false)
  const outside = outsidePreparation(workspace.snapshot, preparation.topics)
  const outsideFiles = groupFileAnchors(workspace.snapshot, outside)
  const proposedFiles = new Set(
    groupFileAnchors(
      workspace.snapshot,
      preparation.topics.flatMap(({ topic }) =>
        topic.steps.flatMap((step) => step.anchors)
      )
    ).map((file) => file.path)
  )
  const pending = preparation.topics.filter(
    (item) => item.choice === "pending"
  ).length
  const applying = preparation.phase === "applying"
  const hasProposal = preparation.topics.length > 0
  const unresolvedAnchors = preparation.topics
    .filter((item) => item.choice !== "rejected")
    .reduce((sum, item) => sum + item.diagnostics.length, 0)
  const anchorStatus = unresolvedAnchors
    ? `${unresolvedAnchors} ${unresolvedAnchors === 1 ? "anchor needs" : "anchors need"} attention.`
    : "All retained anchors match the review files."
  const files = new Set(workspace.snapshot.changes.map((change) => change.path))
    .size
  const additions = workspace.snapshot.changes
    .flatMap((change) => change.passages)
    .reduce((sum, passage) => sum + passage.newLines, 0)
  const deletions = workspace.snapshot.changes
    .flatMap((change) => change.passages)
    .reduce((sum, passage) => sum + passage.oldLines, 0)

  const { active, cancel } = preparation
  useEffect(() => {
    const stop = (event: KeyboardEvent) => {
      if (event.key === "Escape" && active && !editing && !showOutside) {
        event.preventDefault()
        cancel()
      }
    }
    window.addEventListener("keydown", stop)
    return () => window.removeEventListener("keydown", stop)
  }, [active, cancel, editing, showOutside])

  return (
    <div
      className="flex h-full min-h-0 min-w-0 gap-2 px-2 pb-2"
      data-testid="preparing-review"
    >
      <aside
        className="flex min-h-0 w-60 min-w-0 shrink-0 flex-col gap-3 overflow-hidden px-2 pt-1.5 pb-2 xl:w-68"
        aria-label="Rev preparation session"
      >
        <div className="min-h-0 flex-1 space-y-4 overflow-x-hidden overflow-y-auto pr-1">
          <header className="space-y-0.5">
            <h1
              className="truncate text-base font-medium"
              title={workspace.review.title}
            >
              {workspace.review.title}
            </h1>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <HugeiconsIcon icon={GitCommitIcon} size={14} />
              Review files · {files} {files === 1 ? "file" : "files"}
            </p>
          </header>
          <section className="space-y-3" aria-label="Preparation progress">
            <h2 className="text-xs font-medium text-muted-foreground">
              Rev session
            </h2>
            <ol className="space-y-3">
              <SessionStep
                title="Review scope prepared"
                detail={`${files} changed files · +${additions} −${deletions} in the review`}
                done={!!preparation.context}
                busy={
                  preparation.phase === "loading" ||
                  (preparation.active && !preparation.context)
                }
              />
              <SessionStep
                title={`Preparing with ${harnessNames[provider] ?? provider}`}
                detail={
                  hasProposal
                    ? "Topics ready for your review."
                    : provider === "codex" && preparation.phase === "running"
                      ? "Follow Rev’s activity in the main panel."
                      : preparation.status
                }
                done={hasProposal}
                busy={preparation.phase === "running"}
              />
              <SessionStep
                title="Checking anchors in review files"
                detail={hasProposal ? anchorStatus : undefined}
                done={hasProposal}
                busy={preparation.phase === "checking"}
              />
            </ol>
            <div className="flex flex-wrap gap-2 pl-6.5">
              {preparation.active ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={preparation.phase === "cancelled"}
                  onClick={preparation.cancel}
                >
                  Cancel <Kbd>Esc</Kbd>
                </Button>
              ) : (
                !hasProposal &&
                preparation.context && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!preparation.canStart}
                    onClick={() => void preparation.start()}
                  >
                    {preparation.phase === "error" ||
                    preparation.phase === "cancelled"
                      ? "Try again"
                      : "Prepare with Rev"}
                  </Button>
                )
              )}
            </div>
          </section>
          {preparation.phase === "error" && !preparation.context && (
            <Button
              size="sm"
              variant="secondary"
              onClick={preparation.retryContext}
            >
              Retry preparation
            </Button>
          )}
          <section className="space-y-2 border-t pt-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-xs font-medium text-muted-foreground">
                Review scope
              </h2>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="secondary">{files} changed files</Badge>
              <Badge variant="secondary">Autonomous exploration</Badge>
            </div>
            <p className="text-xs leading-4 text-muted-foreground">
              Rev explores the project and captured changes with its harness. It
              chooses what to read and manages its own context.
            </p>
          </section>
        </div>
        <div className="shrink-0 border-t pt-2">
          <Button
            className="w-full"
            size="sm"
            variant="ghost"
            disabled={preparation.active || applying}
            onClick={onDone}
          >
            {preparation.phase === "complete"
              ? "Open review"
              : "Continue manually"}
          </Button>
        </div>
      </aside>
      <main
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-3xl border bg-card/50"
        aria-label="Suggested topics"
      >
        <header className="flex min-h-18 shrink-0 flex-col items-stretch gap-3 border-b px-6 py-4 min-[1100px]:flex-row min-[1100px]:items-center">
          <div className="min-w-0 flex-1">
            <h2 className="text-xl font-medium">Suggested topics</h2>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              Accept, edit or reject each suggestion. Nothing is marked as
              reviewed until you read it.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={!pending || preparation.active || applying}
              onClick={preparation.rejectRemaining}
            >
              Reject remaining
            </Button>
            <Button
              size="sm"
              disabled={!preparation.canApply}
              onClick={() => void preparation.apply()}
            >
              {applying ? <Spinner /> : <HugeiconsIcon icon={PlusSignIcon} />}
              Add {preparation.acceptedCount || ""} accepted{" "}
              {preparation.acceptedCount === 1 ? "topic" : "topics"}
            </Button>
          </div>
        </header>
        <div className="min-h-0 flex-1 space-y-3 overflow-x-hidden overflow-y-auto p-4">
          {preparation.error && (
            <div
              role="alert"
              className="flex gap-2 rounded-2xl bg-destructive/10 p-4 text-sm text-destructive"
            >
              <HugeiconsIcon
                icon={Alert02Icon}
                size={16}
                className="shrink-0"
              />
              <div className="min-w-0 space-y-1 wrap-anywhere">
                <p>{preparation.error}</p>
                <p className="text-foreground">
                  Your frozen review is available. You can retry or continue
                  manually.
                </p>
              </div>
            </div>
          )}
          {preparation.phase === "cancelled" && (
            <p role="status" className="rounded-2xl bg-muted p-4 text-sm">
              {preparation.active
                ? "Stopping the harness…"
                : "Preparation stopped. Your frozen review has been kept."}
            </p>
          )}
          {provider === "codex" && preparation.progress && (
            <PreparationProgress
              key={preparation.progress.runId}
              progress={preparation.progress}
              complete={["suggestions", "applying", "complete"].includes(
                preparation.phase
              )}
              checking={preparation.phase === "checking"}
              status={preparation.status}
            />
          )}
          {preparation.topics.map((item) => (
            <PreparationTopicCard
              key={item.topic.id}
              item={item}
              snapshot={workspace.snapshot}
              disabled={applying}
              onChoose={(choice) => preparation.choose(item.topic.id, choice)}
              onEdit={() => setEditing(item.topic)}
            />
          ))}
          {(provider !== "codex" || !preparation.progress) &&
            (preparation.active || preparation.phase === "loading") && (
              <section
                role="status"
                className="space-y-2.5 rounded-3xl border border-dashed px-4 py-3.5"
              >
                <p className="flex items-center gap-2.5 text-sm text-muted-foreground">
                  <Spinner className="size-4" />
                  {preparation.status}
                </p>
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
              </section>
            )}
          {preparation.phase === "ready" && (
            <div className="space-y-3 rounded-3xl border border-dashed p-6 text-sm text-muted-foreground">
              <HugeiconsIcon icon={AiMagicIcon} size={24} />
              <p>{preparation.status}</p>
              <p>
                The review is already captured. Retry preparation or continue
                manually.
              </p>
            </div>
          )}
        </div>
        <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t glass-bar px-6 py-3">
          <span className="size-3 shrink-0 rounded-full border border-dashed border-muted-foreground" />
          <p className="min-w-0 flex-1 text-xs leading-4 text-muted-foreground">
            {outsideFiles.length}{" "}
            {outsideFiles.length === 1 ? "file has" : "files have"} changes
            outside accepted topics.
            {hasProposal && (
              <span className="block">
                Suggestions reference {proposedFiles.size} of {files} files.{" "}
                {preparation.acceptedCount === 0
                  ? "Accept topics to include them in the tour."
                  : "Only linked changes are included."}
              </span>
            )}
          </p>
          <Button
            variant="ghost"
            size="xs"
            disabled={!outside.length}
            onClick={() => setShowOutside(true)}
          >
            <HugeiconsIcon icon={ArrowRight01Icon} />
            View files
          </Button>
        </footer>
      </main>
      {editing && (
        <PreparationTopicEditor
          key={editing.id}
          topic={editing}
          snapshot={workspace.snapshot}
          onSave={preparation.edit}
          onClose={() => setEditing(null)}
        />
      )}
      {showOutside && (
        <Dialog open onOpenChange={setShowOutside}>
          <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
            <DialogTitle>Outside the tour</DialogTitle>
            <DialogDescription>
              Files with changes outside accepted topics. Suggestions may
              reference a file without covering every change. Accepting a topic
              does not mark code as reviewed.
            </DialogDescription>
            <ul
              className="min-h-0 space-y-2 overflow-y-auto"
              aria-label="Files outside the tour"
            >
              {outsideFiles.map((file) => (
                <li
                  key={file.path}
                  className="space-y-1 rounded-xl bg-muted p-3 text-xs wrap-anywhere"
                >
                  <p className="font-mono">{file.path}</p>
                  <p className="text-muted-foreground">
                    {file.layers.join(" · ")} · {file.anchors.length} of{" "}
                    {file.total} changes outside accepted topics
                  </p>
                  {hasProposal && (
                    <p className="text-muted-foreground">
                      {proposedFiles.has(file.path)
                        ? "Referenced by suggestions; some changes are not in accepted topics."
                        : "Not referenced by any suggested topic."}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
