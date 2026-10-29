"use client"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import type { ReviewCommentAnchor } from "@/lib/desktop/contracts.generated"
import type { SourceSelection } from "@/features/code-editor/contracts/sourceSelection.types"
import type { ReviewCommentsSession } from "../hooks/useReviewComments"
import { ReviewCommentsSummary } from "./ReviewCommentsSummary"
import { ReviewCommentDialog } from "./ReviewCommentDialog"
import { ReviewCommentToolbar } from "./ReviewCommentToolbar"

/** Shared comment interaction for live code and immutable review sources. */
export function CodeComments({
  session,
  snapshotId,
  selection,
}: {
  session: ReviewCommentsSession
  snapshotId?: string
  selection: { value: SourceSelection; anchor: ReviewCommentAnchor } | null
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<ReviewCommentAnchor | null>(null)
  const [text, setText] = useState("")
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setOpen(true)
          void session.reload()
        }}
      >
        Comments
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Review comments</DialogTitle>
            <DialogDescription>
              Human notes on code and explanations.
            </DialogDescription>
          </DialogHeader>
          <ReviewCommentsSummary session={session} snapshotId={snapshotId} />
        </DialogContent>
      </Dialog>
      {!open && !draft && session.editable && selection && (
        <ReviewCommentToolbar
          selection={selection.value}
          disabled={session.busy || !session.document}
          onComment={() => setDraft(selection.anchor)}
        />
      )}
      {draft && (
        <ReviewCommentDialog
          anchor={draft}
          initialText={text}
          busy={session.busy}
          error={session.error}
          onSave={session.mutate}
          onReselect={(value) => {
            setText(value)
            setDraft(null)
          }}
          onClose={() => {
            setText("")
            setDraft(null)
          }}
        />
      )}
    </>
  )
}
