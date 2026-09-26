"use client"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import type { Repository, Review } from "@/lib/desktop/contracts.generated"
import { errorMessage, reviewCommands } from "@/lib/desktop/review.commands"
export function ResumeReviews({
  repository,
  onOpen,
  onNew,
  onError,
}: {
  repository: Repository
  onOpen: (id: string) => void
  onNew: () => void
  onError: (error: string) => void
}) {
  const [reviews, setReviews] = useState<Review[]>([])
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
  return (
    <section className="mx-auto w-full max-w-4xl flex-1 overflow-auto p-10">
      <header className="mb-8 flex justify-between">
        <div>
          <h1 className="text-xl font-medium">Pick up where you left off</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Reviews, questions and decisions are shared in .reviewbox. Your
            reading position stays on this machine.
          </p>
        </div>
        <Button onClick={onNew}>New review</Button>
      </header>
      {reviews.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No reviews yet. Start by freezing the changes you want to understand.
        </p>
      )}
      <div className="divide-y">
        {reviews.map((review) => (
          <div key={review.id} className="flex items-center gap-4 py-5">
            <button
              className="min-w-0 flex-1 text-left"
              onClick={() => onOpen(review.id)}
            >
              <span className="block font-medium">{review.title}</span>
              <span className="mt-2 block text-xs text-muted-foreground">
                {review.topics.length} topics ·{" "}
                {
                  review.annotations.filter((n) => n.question && !n.resolved)
                    .length
                }{" "}
                open questions ·{" "}
                {new Date(Number(review.updatedAt)).toLocaleString()}
              </span>
            </button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpen(review.id)}
            >
              Resume
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDeleting(review)}
            >
              Delete
            </Button>
          </div>
        ))}
      </div>
      <Dialog
        open={!!deleting}
        onOpenChange={(v) => {
          if (!v) setDeleting(null)
        }}
      >
        <DialogContent>
          <DialogTitle>Delete this review?</DialogTitle>
          <DialogDescription>
            This removes the review, notes and decisions from ReviewBox. Your
            repository is not modified.
          </DialogDescription>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (!deleting) return
                reviewCommands
                  .delete(deleting.id)
                  .then(() => {
                    setReviews(reviews.filter((r) => r.id !== deleting.id))
                    setDeleting(null)
                  })
                  .catch((e) => onError(errorMessage(e)))
              }}
            >
              Delete review
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
