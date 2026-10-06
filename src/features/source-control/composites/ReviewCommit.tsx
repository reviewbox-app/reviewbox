"use client"
import { useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { AiMagicIcon, Tick02Icon } from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import {
  useEditorStore,
  dirty,
} from "@/features/code-editor/stores/editor.store"
import { errorMessage } from "@/lib/desktop/review.commands"
import { useReviewCommit } from "../hooks/useReviewCommit"

const phases = [
  ["stage", "Stage changes"],
  ["plan", "Prepare commits with Rev"],
  ["commit", "Create commits"],
] as const
export function ReviewCommit({
  repositoryId,
  reviewId,
  onConfigure,
  onFinish,
  hasChanges,
}: {
  repositoryId: string
  reviewId: string
  onConfigure?: () => void
  onFinish?: () => void
  hasChanges?: boolean
}) {
  const job = useReviewCommit(repositoryId, reviewId)
  const [copyMessage, setCopyMessage] = useState("")
  const unsaved = useEditorStore(
    (s) => s.sessions[repositoryId]?.buffers.some(dirty) ?? false
  )
  const operation = job.state?.operation
  const running = job.starting || operation?.status === "running"
  const success = operation?.status === "completed"
  const error = job.error || operation?.error
  const phase = job.state?.phase
  const phaseIndex =
    phase === "done" ? phases.length : phases.findIndex(([id]) => id === phase)
  return (
    <section className="space-y-3" aria-label="Commit project changes">
      <div className="flex flex-wrap gap-2">
        {onFinish && (
          <Button variant="secondary" onClick={onFinish}>
            Finish review
          </Button>
        )}
        {!success && hasChanges !== false && (
          <Button
            disabled={running || hasChanges !== true}
            onClick={() => void job.start()}
          >
            {running ? <Spinner /> : <HugeiconsIcon icon={AiMagicIcon} />}
            Stage &amp; commit with Rev
          </Button>
        )}
      </div>
      {!success && !running && hasChanges === false && (
        <p role="status" className="text-sm text-muted-foreground">
          Nothing to commit. Your working tree is clean.
        </p>
      )}
      {!success && hasChanges !== false && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Includes all saved Git changes in this project, including changes
            outside this review. Creates commits without pushing.
          </p>
          {unsaved && (
            <p className="text-xs text-muted-foreground">
              Unsaved editor changes are not included. Save them first to
              include them.
            </p>
          )}
        </div>
      )}
      {operation && (
        <>
          {operation.message !== "Nothing to commit" && (
            <ol className="space-y-2 text-sm" aria-label="Commit steps">
              {phases.map(([id, title], index) => (
                <li key={id} className="flex items-center gap-2">
                  {index < phaseIndex ? (
                    <HugeiconsIcon
                      icon={Tick02Icon}
                      size={16}
                      className="text-review-validated"
                    />
                  ) : index === phaseIndex && running ? (
                    <Spinner className="size-4" />
                  ) : (
                    <span className="size-4 rounded-full border" />
                  )}
                  <span
                    className={index > phaseIndex ? "opacity-60" : undefined}
                  >
                    {title}
                  </span>
                </li>
              ))}
            </ol>
          )}
          <p role="status" className="text-sm">
            {operation.message}
          </p>
          {operation.commits.length > 0 && (
            <ul className="space-y-1 text-sm">
              {operation.commits.map((commit) => (
                <li key={commit.oid}>
                  <code className="mr-2 text-xs text-muted-foreground">
                    {commit.oid.slice(0, 7)}
                  </code>
                  {commit.subject}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {running && (
        <Button size="sm" variant="secondary" onClick={() => void job.stop()}>
          Stop
        </Button>
      )}
      {error && (
        <div className="space-y-2 text-sm" role="alert">
          <p className="text-destructive">{error}</p>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(error)
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
          {copyMessage && <p role="status">{copyMessage}</p>}
          {onConfigure && (
            <Button size="sm" variant="secondary" onClick={onConfigure}>
              Configure Rev
            </Button>
          )}
        </div>
      )}
    </section>
  )
}
