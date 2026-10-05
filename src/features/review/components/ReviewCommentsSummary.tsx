"use client"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { MarkdownCodeBlock } from "@/features/markdown/components/MarkdownCodeBlock"
import type { ReviewComment } from "@/lib/desktop/contracts.generated"
import type { ReviewCommentsSession } from "../hooks/useReviewComments"
import { commentLocation } from "../helpers/reviewComment.helpers"
import { ReviewCommentDialog } from "./ReviewCommentDialog"

export function ReviewCommentsSummary({
  session,
  snapshotId,
}: {
  session: ReviewCommentsSession
  snapshotId: string
}) {
  const [editing, setEditing] = useState<ReviewComment>()
  const comments = session.document?.comments ?? []
  const open = comments.filter((comment) => comment.status === "open").length
  return (
    <section aria-label="Review comments" className="space-y-5">
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Comments for your agent</h2>
        <p className="text-sm text-muted-foreground">
          {open} open · {comments.length - open} addressed ·{" "}
          {new Set(comments.map((comment) => comment.anchor.path)).size} files
        </p>
        <p className="text-sm text-muted-foreground">
          You can now ask your agent to address these comments. Return to the
          review to add more. This summary does not validate or publish the
          review.
        </p>
      </div>
      {session.error && (
        <div role="alert" className="space-y-2 text-sm text-destructive">
          {session.error}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void session.reload()}
          >
            Reload comments
          </Button>
        </div>
      )}
      {!session.document && !session.error && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading comments…
        </p>
      )}
      {session.document && (
        <MarkdownCodeBlock
          source={session.document.correctionPrompt}
          label="Prompt for your working agent"
        />
      )}
      {session.document?.sharedFilePresent && (
        <p className="text-xs text-muted-foreground">
          A shared .reviewbox/REVIEW_COMMENTS.md also exists. The prompt asks
          your agent to check it.
        </p>
      )}
      <ul className="space-y-4">
        {comments.map((comment) => (
          <li key={comment.id} className="space-y-3 rounded-xl border p-4">
            <div className="flex items-start justify-between gap-3">
              <p className="min-w-0 font-mono text-xs break-words text-muted-foreground">
                {commentLocation(comment.anchor)}
              </p>
              <span className="text-xs text-muted-foreground">
                {comment.status === "open" ? "Open" : "Addressed"}
              </span>
            </div>
            {comment.anchor.snapshotId !== snapshotId && (
              <p className="text-xs text-muted-foreground">
                Comment on an earlier capture. Compare the excerpt before
                applying a correction.
              </p>
            )}
            <p className="text-sm whitespace-pre-wrap">{comment.text}</p>
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">Selected source</summary>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap">
                {comment.anchor.excerpt}
              </pre>
            </details>
            {comment.resolution && (
              <p className="text-sm whitespace-pre-wrap">
                <strong>Resolution: </strong>
                {comment.resolution}
              </p>
            )}
            {comment.tests && (
              <p className="text-sm whitespace-pre-wrap">
                <strong>Tests: </strong>
                {comment.tests}
              </p>
            )}
            {session.editable && (
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={session.busy}
                  onClick={() => setEditing(comment)}
                >
                  Edit comment
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={session.busy}
                  onClick={() =>
                    void session.mutate({ kind: "delete", id: comment.id })
                  }
                >
                  Delete comment
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {editing && (
        <ReviewCommentDialog
          key={editing.id}
          anchor={editing.anchor}
          comment={editing}
          busy={session.busy}
          error={session.error}
          onSave={session.mutate}
          onClose={() => setEditing(undefined)}
        />
      )}
    </section>
  )
}
