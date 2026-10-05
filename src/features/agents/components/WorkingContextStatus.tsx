"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { call, errorMessage } from "@/lib/desktop/review.commands"
import type { ReviewWorkingContext } from "@/lib/desktop/contracts.generated"

export function WorkingContextStatus({
  repositoryId,
  reviewId,
  revision,
  completed = false,
}: {
  repositoryId: string
  reviewId: string
  revision?: string | number
  completed?: boolean
}) {
  const [context, setContext] = useState<ReviewWorkingContext | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let alive = true
    call<ReviewWorkingContext>("review_working_context", {
      repositoryId,
      reviewId,
    })
      .then((value) => {
        if (alive) {
          setContext(value)
          setError("")
        }
      })
      .catch((cause) => {
        if (alive) setError(errorMessage(cause))
      })
    return () => {
      alive = false
    }
  }, [repositoryId, reviewId, revision])
  return (
    <div
      className="space-y-2 text-xs text-muted-foreground"
      aria-label="Work context"
    >
      {context && !context.files.length && (
        <p>No CURRENT_CHANGES.md context was captured for this review.</p>
      )}
      {context?.files.map((file) => (
        <div key={file.path}>
          <p>
            <span className="font-medium">{file.path}</span> ·{" "}
            {file.status === "accepted"
              ? "Used by Rev"
              : file.status === "stale"
                ? "Ignored: stale context"
                : "Not verified"}
          </p>
          <p>{file.reason}</p>
          {file.cleanup === "trashed" && (
            <p>Moved to Trash after review completion.</p>
          )}
          {file.cleanup === "changed" && <p>A newer brief was preserved.</p>}
          {file.recoveryPath && (
            <p className="break-all">
              Preserved recovery file: {file.recoveryPath}
            </p>
          )}
          {file.cleanup.startsWith("error:") && (
            <p role="alert">
              Could not move the brief to Trash: {file.cleanup.slice(7)}
            </p>
          )}
        </div>
      ))}
      {completed &&
        (error ||
          context?.files.some(
            (file) =>
              file.status === "accepted" &&
              (file.cleanup === "pending" || file.cleanup.startsWith("error:"))
          )) && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              setError("")
              try {
                setContext(
                  await call<ReviewWorkingContext>(
                    "retry_working_context_cleanup",
                    { repositoryId, reviewId }
                  )
                )
              } catch (cause) {
                setError(errorMessage(cause))
              } finally {
                setBusy(false)
              }
            }}
          >
            Retry moving context to Trash
          </Button>
        )}
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
