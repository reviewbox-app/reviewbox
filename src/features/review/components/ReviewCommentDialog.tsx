"use client"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import type {
  ReviewComment,
  ReviewCommentAnchor,
  ReviewCommentMutation,
} from "@/lib/desktop/contracts.generated"
import { commentLocation } from "../helpers/reviewComment.helpers"

export function ReviewCommentDialog({
  anchor,
  comment,
  busy,
  error,
  onSave,
  onClose,
}: {
  anchor: ReviewCommentAnchor
  comment?: ReviewComment
  busy: boolean
  error?: string
  onSave: (mutation: ReviewCommentMutation) => Promise<boolean>
  onClose: () => void
}) {
  const [id] = useState(() => comment?.id ?? crypto.randomUUID())
  const [text, setText] = useState(comment?.text ?? "")
  const [addressed, setAddressed] = useState(comment?.status === "addressed")
  const [resolution, setResolution] = useState(comment?.resolution ?? "")
  const [tests, setTests] = useState(comment?.tests ?? "")
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {comment ? "Edit review comment" : "Add review comment"}
          </DialogTitle>
          <DialogDescription>{commentLocation(anchor)}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            const mutation: ReviewCommentMutation = comment
              ? {
                  kind: "edit",
                  id,
                  text,
                  status: addressed ? "addressed" : "open",
                  resolution,
                  tests,
                }
              : { kind: "add", id, anchor, text }
            void onSave(mutation).then((saved) => {
              if (saved) onClose()
            })
          }}
        >
          <label className="block space-y-2 text-sm">
            <span>Comment</span>
            <Textarea
              autoFocus
              aria-label="Review comment"
              value={text}
              onChange={(event) => setText(event.target.value)}
              maxLength={32768}
              disabled={busy}
              className="min-h-28"
            />
          </label>
          {comment && (
            <>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={addressed}
                  onCheckedChange={setAddressed}
                  disabled={busy}
                />{" "}
                Addressed
              </label>
              <label className="block space-y-2 text-sm">
                <span>Resolution</span>
                <Textarea
                  aria-label="Comment resolution"
                  value={resolution}
                  onChange={(event) => setResolution(event.target.value)}
                  disabled={busy}
                  maxLength={32768}
                />
              </label>
              <label className="block space-y-2 text-sm">
                <span>Tests performed</span>
                <Textarea
                  aria-label="Comment tests"
                  value={tests}
                  onChange={(event) => setTests(event.target.value)}
                  disabled={busy}
                  maxLength={32768}
                />
              </label>
            </>
          )}
          <p className="text-xs text-muted-foreground">
            Saved in .reviewbox/.local/REVIEW_COMMENTS.md. Source files stay
            unchanged.
          </p>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !text.trim()}>
              {busy ? "Saving…" : "Save comment"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
