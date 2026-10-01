"use client"
import { useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  SparklesIcon,
  Delete02Icon,
  AlertCircleIcon,
  Alert02Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog"
import type { Workspace } from "@/lib/desktop/contracts.generated"
import { errorMessage } from "@/lib/desktop/review.commands"
import { ReviewPreparationContent } from "../components/ReviewPreparationContent"
import type { ReviewPreparationView } from "../contracts/preparation.types"
import type { useReviewUpdate } from "../hooks/useReviewUpdate"

const indicators = {
  running: { label: "In progress", icon: SparklesIcon, tone: "" },
  failed: {
    label: "Review failed",
    icon: AlertCircleIcon,
    tone: "bg-destructive/10 text-destructive hover:bg-destructive/20 hover:text-destructive aria-expanded:bg-destructive/20 aria-expanded:text-destructive dark:hover:bg-destructive/20",
  },
  interrupted: {
    label: "Review interrupted",
    icon: Alert02Icon,
    tone: "bg-review-attention-soft text-review-attention hover:bg-review-attention/20 hover:text-review-attention aria-expanded:bg-review-attention/20 aria-expanded:text-review-attention dark:hover:bg-review-attention/20",
  },
  stale: {
    label: "Update with Rev",
    icon: Alert02Icon,
    tone: "bg-review-attention-soft text-review-attention hover:bg-review-attention/20 hover:text-review-attention aria-expanded:bg-review-attention/20 aria-expanded:text-review-attention dark:hover:bg-review-attention/20",
  },
  checking: { label: "Checking review", icon: SparklesIcon, tone: "" },
  done: {
    label: "Review done",
    icon: Tick02Icon,
    tone: "bg-review-validated-soft text-review-validated hover:bg-review-validated/20 hover:text-review-validated aria-expanded:bg-review-validated/20 aria-expanded:text-review-validated dark:hover:bg-review-validated/20",
  },
} as const

export function ReviewUpdateStatus({
  update,
  workspace,
  changed,
  freshnessChecked = true,
  onCheck,
  staleStepIds = [],
  busy,
  onDelete,
  onRead,
}: {
  update: ReturnType<typeof useReviewUpdate>
  workspace: Workspace
  changed: boolean
  freshnessChecked?: boolean
  onCheck?: () => Promise<void>
  staleStepIds?: string[]
  busy: boolean
  onDelete: () => Promise<void>
  onRead: () => void
}) {
  const dialog = useRef<HTMLDivElement>(null)
  const [details, setDetails] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState("")
  const [seenCompletions, setSeenCompletions] = useState<Set<string>>(
    () => new Set()
  )
  const running = update.active || update.pending
  const stopped = !!update.state && update.state.status !== "ready" && !running
  const failed = update.state?.status === "failed" || !!update.error
  const status = running
    ? "running"
    : failed
      ? "failed"
      : stopped
        ? "interrupted"
        : changed || !workspace.review.preparationId
          ? "stale"
          : !freshnessChecked
            ? "checking"
            : "done"
  const indicator = indicators[status]
  const completionId = `${workspace.review.id}/${update.state?.id ?? workspace.review.preparationId}`
  const acknowledged =
    status === "done" && (details || seenCompletions.has(completionId))
  const showDetails = (open: boolean) => {
    // Opening the dropdown alone does not acknowledge the completed pass.
    // Also acknowledge a pass that finishes while its dialog is already open.
    if (status === "done")
      setSeenCompletions((seen) => new Set(seen).add(completionId))
    setDetails(open)
  }
  const preparation: ReviewPreparationView = {
    ...update,
    state:
      update.pending && update.state?.status === "ready" ? null : update.state,
    error: update.error || update.state?.error?.message || "",
    status: update.pending
      ? "Capturing changes…"
      : update.active
        ? "Rev is working…"
        : update.message,
    start: update.state?.adaptation ? update.resume : update.startCreation,
  }
  const read = () => {
    showDetails(false)
    if (update.needsOpen) void update.openReview()
    else onRead()
  }
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              size="icon-sm"
              variant="ghost"
              className={acknowledged ? undefined : indicator.tone}
              data-rev-status={acknowledged ? "seen" : status}
              aria-label={`Rev: ${indicator.label}`}
              title={`Rev: ${indicator.label}`}
            />
          }
        >
          {running ? (
            <Spinner />
          ) : (
            <HugeiconsIcon
              icon={acknowledged ? SparklesIcon : indicator.icon}
            />
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem
            onClick={() => {
              showDetails(true)
              if (!running) void onCheck?.()
            }}
          >
            {running ? <Spinner /> : <HugeiconsIcon icon={indicator.icon} />}
            {indicator.label}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            disabled={
              busy ||
              update.pending ||
              workspace.review.publication.status === "published" ||
              workspace.review.publication.status === "archived"
            }
            onClick={() => setDeleting(true)}
          >
            <HugeiconsIcon icon={Delete02Icon} />
            Delete current review
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={details} onOpenChange={showDetails}>
        <DialogContent
          ref={dialog}
          initialFocus={dialog}
          className="gap-0 overflow-hidden p-0 sm:max-w-[640px] [&>[data-slot=dialog-close]]:z-10"
        >
          <DialogHeader className="sr-only">
            <DialogTitle>Review preparation</DialogTitle>
            <DialogDescription>
              Follow Rev’s work on the captured changes.
            </DialogDescription>
          </DialogHeader>
          <div
            className="max-h-[85svh] overflow-y-auto"
            aria-label="Rev preparation details"
          >
            <ReviewPreparationContent
              workspace={workspace}
              autoFocusStart={false}
              preparation={preparation}
              updating={!!update.state?.adaptation}
              reviewStatus={{
                needsUpdate: changed || !workspace.review.preparationId,
                checking: !freshnessChecked,
                staleStepIds,
                busy: busy || running,
                onUpdate: () => void update.start(),
              }}
              onStart={read}
              onLeave={() => showDetails(false)}
              onDiscard={() => void update.discard()}
            />
          </div>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={deleting}
        onOpenChange={(open) => {
          if (!removing) setDeleting(open)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete current review?</AlertDialogTitle>
            <AlertDialogDescription>
              This stops any preparation and removes the local review, its
              documents and its decisions. Your source files remain unchanged.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={removing}
              onClick={async () => {
                setRemoving(true)
                setError("")
                try {
                  await onDelete()
                  setDeleting(false)
                } catch (cause) {
                  setError(errorMessage(cause))
                } finally {
                  setRemoving(false)
                }
              }}
            >
              {removing && <Spinner />}Delete review
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
