"use client"
import { useEffect, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Add01Icon,
  ArrowRight01Icon,
  Database01Icon,
  Delete02Icon,
  GitCommitIcon,
  MoreHorizontalIcon,
  Download01Icon,
} from "@hugeicons/core-free-icons"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type {
  Coverage,
  Repository,
  Review,
} from "@/lib/desktop/contracts.generated"
import { errorMessage, reviewCommands } from "@/lib/desktop/review.commands"
import { cn } from "@/lib/utils"
import { ReviewStatus } from "../components/ReviewStatus"
import { shortTime } from "../helpers/review.helpers"
import { readerCommands } from "../services/reader.commands"
import { getReadingPreferences } from "@/features/settings/hooks/useReadingPreferences"

function stepOf(review: Review, stepId?: string | null) {
  if (!stepId) return null
  for (const topic of review.topics) {
    const index = topic.steps.findIndex((step) => step.id === stepId)
    if (index >= 0) return { topic, step: topic.steps[index], index }
  }
  return null
}

function ListRow({
  status,
  title,
  meta,
  muted,
  onClick,
  action,
}: {
  status: React.ComponentProps<typeof ReviewStatus>["status"]
  title: string
  meta: string
  muted?: boolean
  onClick: () => void
  action?: string
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-2xl border bg-card px-4 py-3 text-left outline-none hover:bg-accent/40 focus-visible:ring-3 focus-visible:ring-ring/30"
    >
      <ReviewStatus status={status} />
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate text-sm",
            muted && "text-muted-foreground"
          )}
        >
          {title}
        </span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          {meta}
        </span>
      </span>
      {action ? (
        <span className="text-xs font-medium">{action}</span>
      ) : (
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          size={16}
          className="text-muted-foreground"
        />
      )}
    </button>
  )
}

export function ResumeReviews({
  repository,
  onOpen,
  onNew,
  onError,
  onDeleted,
}: {
  repository: Repository
  onOpen: (id: string) => void
  onNew: () => void
  onError: (error: string) => void
  onDeleted: (id: string) => void
}) {
  const [reviews, setReviews] = useState<Review[]>([])
  const [coverage, setCoverage] = useState<Record<string, Coverage>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<Review | null>(null)
  useEffect(() => {
    let alive = true
    const reload = () =>
      reviewCommands
        .reviews(repository.id)
        .then((v) => {
          if (alive)
            setReviews(
              v.sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt))
            )
        })
        .catch((e) => onError(errorMessage(e)))
    reload()
    const timer = setInterval(reload, 2500)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [repository.id, onError])
  const revisions = reviews.map((r) => `${r.id}:${r.revision}`).join()
  useEffect(() => {
    let alive = true
    const ids = revisions
      ? revisions.split(",").map((v) => v.split(":")[0])
      : []
    Promise.all(
      ids.map((id) => reviewCommands.coverage(id).then((c) => [id, c] as const))
    )
      .then((entries) => {
        if (alive) setCoverage(Object.fromEntries(entries))
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [revisions])
  const review = reviews.find((r) => r.id === selectedId) ?? reviews[0]
  const groups = [
    {
      title: "In progress",
      items: reviews.filter((r) => !coverage[r.id]?.complete),
    },
    {
      title: "Complete",
      items: reviews.filter((r) => coverage[r.id]?.complete),
    },
  ]
  const position =
    review &&
    review.position.context === "guided" &&
    stepOf(review, review.position.stepId)
  const complete = review ? coverage[review.id]?.complete : false
  return (
    <div
      className="flex min-h-0 flex-1 gap-2 px-2 pb-2"
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target === e.currentTarget && review)
          onOpen(review.id)
      }}
    >
      <aside className="flex w-[272px] shrink-0 flex-col pt-2 pb-2 max-[1100px]:w-[220px]">
        <div className="flex items-center justify-between px-3">
          <h1 className="text-[17px] font-medium">Reviews</h1>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="New review"
            onClick={onNew}
          >
            <HugeiconsIcon icon={Add01Icon} size={14} />
          </Button>
        </div>
        <nav className="mt-3 min-h-0 flex-1 space-y-4 overflow-auto px-1">
          {groups.map(
            (group) =>
              group.items.length > 0 && (
                <section key={group.title}>
                  <h2 className="px-2 pb-1 text-xs text-muted-foreground">
                    {group.title}
                  </h2>
                  {group.items.map((item) => (
                    <button
                      key={item.id}
                      onClick={() => setSelectedId(item.id)}
                      onDoubleClick={() => onOpen(item.id)}
                      className={cn(
                        "flex w-full items-start gap-2.5 rounded-xl px-2 py-1.5 text-left outline-none hover:bg-accent/60 focus-visible:ring-3 focus-visible:ring-ring/30",
                        item.id === review?.id && "bg-accent hover:bg-accent"
                      )}
                    >
                      <span className="flex h-5 items-center">
                        <ReviewStatus
                          status={
                            coverage[item.id]?.complete
                              ? "Validated"
                              : "In progress"
                          }
                        />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm">
                          {item.title}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {repository.name} · {item.snapshotId.slice(0, 6)} ·{" "}
                          {shortTime(item.updatedAt)}
                        </span>
                      </span>
                    </button>
                  ))}
                </section>
              )
          )}
        </nav>
        <p className="flex items-center gap-1.5 px-3 pt-3 text-xs text-muted-foreground">
          <HugeiconsIcon icon={Database01Icon} size={14} />
          Saved in .reviewbox · no account
        </p>
      </aside>
      <main className="min-w-0 flex-1 overflow-auto rounded-panel border bg-card">
        {!review ? (
          <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center gap-4 p-8 text-center">
            <h2 className="text-lg font-medium">No reviews yet</h2>
            <p className="text-sm leading-6 text-muted-foreground">
              Start by freezing the changes you want to understand. Reviews and
              decisions are shared in .reviewbox.
            </p>
            <Button onClick={onNew}>New review</Button>
          </div>
        ) : (
          <article className="mx-auto w-full max-w-[760px] space-y-8 px-8 py-10">
            <header>
              <div className="flex items-center gap-3">
                <h2 className="truncate text-2xl font-medium">
                  {review.title}
                </h2>
                <Badge variant="secondary">
                  {complete ? "Complete" : "In progress"}
                </Badge>
                <span className="flex-1" />
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Review actions"
                      />
                    }
                  >
                    <HugeiconsIcon icon={MoreHorizontalIcon} size={16} />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={() => {
                        void readerCommands
                          .exportSummary(
                            review.id,
                            getReadingPreferences().level
                          )
                          .catch((cause) => onError(errorMessage(cause)))
                      }}
                    >
                      <HugeiconsIcon icon={Download01Icon} size={16} />
                      Export Markdown
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => setDeleting(review)}
                    >
                      <HugeiconsIcon icon={Delete02Icon} size={16} />
                      Delete review…
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                <HugeiconsIcon icon={GitCommitIcon} size={12} />
                {repository.name} · {repository.branch} · snapshot{" "}
                {review.snapshotId.slice(0, 6)} · started{" "}
                {shortTime(review.createdAt)} · {review.topics.length} topics,{" "}
                {review.topics.reduce((n, t) => n + t.steps.length, 0)} steps
              </p>
            </header>
            <section className="flex items-center gap-4 rounded-3xl bg-secondary p-5">
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted-foreground">
                  You stopped here
                </p>
                <p className="mt-1 truncate font-medium">
                  {position
                    ? position.step.title
                    : review.position.context === "files"
                      ? (review.files.find(
                          (file) => file.id === review.position.fileId
                        )?.path ?? "Start of the file review")
                      : "Start of the review"}
                </p>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {position
                    ? `${position.topic.title} · step ${position.index + 1} of ${position.topic.steps.length} · read ${shortTime(review.updatedAt)}`
                    : `Last opened ${shortTime(review.updatedAt)}`}
                </p>
              </div>
              <Button autoFocus onClick={() => onOpen(review.id)}>
                Resume
              </Button>
              <Kbd>↵</Kbd>
            </section>
            {review.decisions.length > 0 && (
              <section className="space-y-2">
                <h3 className="text-sm font-medium">
                  Past decisions{" "}
                  <span className="font-normal text-muted-foreground">
                    kept for reference
                  </span>
                </h3>
                {review.decisions
                  .slice()
                  .reverse()
                  .map((decision) => {
                    const where =
                      decision.target.kind === "step"
                        ? stepOf(review, decision.target.stepId)
                        : null
                    const file =
                      decision.target.kind === "file"
                        ? review.files.find(
                            (file) =>
                              decision.target.kind === "file" &&
                              file.id === decision.target.fileId
                          )
                        : null
                    const validated = decision.state === "validated"
                    return (
                      <ListRow
                        key={decision.id}
                        status={validated ? "Validated" : "In progress"}
                        title={
                          where?.step.title ?? file?.path ?? "Previous decision"
                        }
                        meta={`${validated ? "Validated" : "Examined"} ${shortTime(decision.createdAt)} · ${decision.target.kind}`}
                        onClick={() => onOpen(review.id)}
                      />
                    )
                  })}
              </section>
            )}
          </article>
        )}
      </main>
      {deleting && (
        <AlertDialog
          open
          onOpenChange={(v) => {
            if (!v) setDeleting(null)
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete “{deleting.title}”?</AlertDialogTitle>
              <AlertDialogDescription>
                This removes the shared review, its documents and its decisions
                from .reviewbox. Your source files remain unchanged.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel variant="secondary">Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => {
                  if (!deleting) return
                  reviewCommands
                    .delete(deleting.id)
                    .then(() => {
                      setReviews(reviews.filter((r) => r.id !== deleting.id))
                      onDeleted(deleting.id)
                      setDeleting(null)
                    })
                    .catch((e) => onError(errorMessage(e)))
                }}
              >
                Delete review
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  )
}
