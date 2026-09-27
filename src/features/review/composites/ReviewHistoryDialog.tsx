"use client"
import { useEffect, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { ReviewCodePane } from "./ReviewCodePane"
import type { Review, Workspace } from "@/lib/desktop/contracts.generated"
import { errorMessage, reviewCommands } from "@/lib/desktop/review.commands"

export function ReviewHistoryDialog({
  workspace,
  onClose,
}: {
  workspace: Workspace
  onClose: () => void
}) {
  const [history, setHistory] = useState<Review[]>([])
  const [past, setPast] = useState<Workspace | null>(null)
  const [changeId, setChangeId] = useState("")
  const [error, setError] = useState("")
  useEffect(() => {
    let alive = true
    reviewCommands
      .history(workspace.review.id)
      .then((v) => {
        if (alive) setHistory(v)
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e))
      })
    return () => {
      alive = false
    }
  }, [workspace.review.id])
  const select = async (revision: number) => {
    try {
      const value = await reviewCommands.historical(
        workspace.review.id,
        revision
      )
      setPast(value)
      setChangeId(value.snapshot.changes[0]?.id ?? "")
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  const change = past?.snapshot.changes.find((c) => c.id === changeId)
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v) onClose()
      }}
    >
      <DialogContent className="flex h-[85vh] flex-col sm:max-w-[min(1200px,95vw)]">
        <DialogTitle>Review history</DialogTitle>
        <DialogDescription>
          Read earlier frozen versions and their recorded decisions. The active
          review stays on its current snapshot.
        </DialogDescription>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex min-h-0 flex-1 gap-5">
          <aside className="w-64 shrink-0 overflow-auto">
            {history.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Capturing a new version adds the previous review here.
              </p>
            )}
            {history.map((review) => (
              <Button
                key={review.revision}
                className="mb-2 h-auto w-full justify-start py-3"
                variant={
                  past?.review.revision === review.revision
                    ? "secondary"
                    : "outline"
                }
                onClick={() => void select(review.revision)}
              >
                <span className="text-left">
                  {new Date(Number(review.updatedAt)).toLocaleString()}
                  <span className="mt-1 block text-xs text-muted-foreground">
                    Snapshot {review.snapshotId.slice(0, 6)}
                  </span>
                </span>
              </Button>
            ))}
            {past && (
              <>
                <p className="my-4 text-xs text-muted-foreground">
                  {
                    past.review.decisions.filter(
                      (d) => d.anchor.snapshotId === past.snapshot.id
                    ).length
                  }{" "}
                  validations ·{" "}
                  {
                    past.review.annotations.filter(
                      (a) => a.question && !a.resolved
                    ).length
                  }{" "}
                  open questions
                </p>
                {past.snapshot.changes.map((c) => (
                  <Button
                    key={c.id}
                    className="mb-1 w-full justify-start font-mono text-xs"
                    variant={c.id === changeId ? "secondary" : "ghost"}
                    onClick={() => setChangeId(c.id)}
                  >
                    {c.path} · {c.layer}
                  </Button>
                ))}
                <div className="mt-5 space-y-3">
                  {past.review.annotations
                    .filter((a) => a.anchor.changeId === changeId)
                    .map((a) => (
                      <p
                        key={a.id}
                        className="rounded-2xl border p-3 text-xs whitespace-pre-wrap"
                      >
                        {a.question ? "Question" : "Note"} · {a.author}
                        <br />
                        {a.body.startsWith("{")
                          ? "Rich-text note retained in this historical version."
                          : a.body}
                      </p>
                    ))}
                </div>
              </>
            )}
          </aside>
          <main className="flex min-w-0 flex-1 overflow-hidden rounded-xl border">
            {past && change ? (
              <ReviewCodePane
                key={change.id}
                snapshot={past.snapshot}
                change={change}
                selection={null}
                position={past.review.position}
                onPosition={() => {}}
              />
            ) : (
              <p className="p-8 text-sm text-muted-foreground">
                Choose a version to inspect its code.
              </p>
            )}
          </main>
        </div>
      </DialogContent>
    </Dialog>
  )
}
