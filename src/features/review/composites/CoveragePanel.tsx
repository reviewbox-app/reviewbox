"use client"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { ReviewStatus } from "../components/ReviewStatus"
import { anchorFor, passageStatus } from "../helpers/review.helpers"
import type { CodeAnchor, Workspace } from "@/lib/desktop/contracts.generated"
export function CoveragePanel({
  workspace,
  onSelect,
  onClose,
}: {
  workspace: Workspace
  onSelect: (anchor: CodeAnchor) => void
  onClose: () => void
}) {
  const [outside, setOutside] = useState(false)
  const included = new Set(
    workspace.review.topics.flatMap((t) =>
      t.steps.flatMap((s) => s.anchors.map((a) => a.passageId))
    )
  )
  return (
    <section className="min-w-0 flex-1 overflow-auto p-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-medium">Review coverage</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Every included passage remains part of the review, even outside a
            topic.
          </p>
        </div>
        <Button variant="outline" onClick={onClose}>
          Back to code
        </Button>
      </header>
      <div className="mb-4 flex gap-2">
        <Button
          size="sm"
          variant={!outside ? "secondary" : "ghost"}
          onClick={() => setOutside(false)}
        >
          All changes
        </Button>
        <Button
          size="sm"
          variant={outside ? "secondary" : "ghost"}
          onClick={() => setOutside(true)}
        >
          Outside the tour
        </Button>
      </div>
      <div className="divide-y">
        {workspace.snapshot.changes.flatMap((c) =>
          c.passages
            .filter((p) => !outside || !included.has(p.id))
            .map((p) => {
              const anchor = anchorFor(workspace.snapshot, c.id, p)
              const status = passageStatus(workspace, anchor)
              return (
                <button
                  key={p.id}
                  onClick={() => onSelect(anchor)}
                  className="flex w-full items-center gap-3 py-4 text-left text-sm hover:bg-accent"
                >
                  <ReviewStatus status={status} />
                  <span className="flex-1">
                    <span className="font-mono text-xs">{c.path}</span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {c.layer} · lines {p.newStart}–
                      {p.newStart + Math.max(p.newLines, 1) - 1}
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {status}
                  </span>
                </button>
              )
            })
        )}
      </div>
    </section>
  )
}
