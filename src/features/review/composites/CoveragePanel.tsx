"use client"
import { useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Cancel01Icon } from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type {
  CodeAnchor,
  Coverage,
  Workspace,
} from "@/lib/desktop/contracts.generated"
import { cn } from "@/lib/utils"
import { CoverageBar, coverageSegments } from "../components/CoverageBar"
import { FileRow } from "../components/FileRow"
import { ReviewStatus, type ReadingStatus } from "../components/ReviewStatus"
import {
  anchorFor,
  lineRange,
  passageStatus,
  outsideReviewFiles,
} from "../helpers/review.helpers"

const cell: Record<ReadingStatus, string> = {
  Validated: "bg-review-validated",
  "In progress": "bg-primary",
  Question: "bg-review-question",
  "Re-review": "bg-review-attention",
  Unread: "bg-muted-foreground/60",
  Uncovered: "bg-muted",
}

export function CoveragePanel({
  workspace,
  coverage,
  onSelect,
  onClose,
}: {
  workspace: Workspace
  coverage: Coverage | null
  onSelect: (anchor: CodeAnchor) => void
  onClose: () => void
}) {
  const outsideFiles = outsideReviewFiles(workspace)
  const [outside, setOutside] = useState(false)
  const steps = new Map(
    workspace.review.topics.flatMap((topic) =>
      topic.steps.flatMap((step, index) =>
        step.anchors.map(
          (a) => [a.passageId, `${topic.title} · step ${index + 1}`] as const
        )
      )
    )
  )
  const files = workspace.snapshot.changes
    .map((change) => ({
      change,
      passages: change.passages.map((passage) => {
        const anchor = anchorFor(workspace.snapshot, change.id, passage)
        const inTour = steps.has(passage.id)
        const status = passageStatus(workspace, anchor)
        return {
          passage,
          anchor,
          inTour,
          status: (!inTour && status === "Unread"
            ? "Uncovered"
            : status) as ReadingStatus,
        }
      }),
    }))
    .filter((file) => !outside || file.passages.some((p) => !p.inTour))
  return (
    <section className="min-w-0 flex-1 overflow-auto" aria-label="Coverage">
      <header className="sticky top-0 z-10 space-y-4 border-b bg-card/80 px-6 pt-4 pb-5 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <Tabs
            value={outside ? "outside" : "all"}
            onValueChange={(value) => setOutside(value === "outside")}
          >
            <TabsList>
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="outside">
                Outside the tour · {outsideFiles.length} files
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <span className="flex-1" />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Back to code (Esc)"
            onClick={onClose}
          >
            <HugeiconsIcon icon={Cancel01Icon} size={16} />
          </Button>
        </div>
        <p className="text-sm leading-6">
          {coverage?.validated ?? 0} of {coverage?.total ?? 0} passages
          validated, {coverage?.outside ?? 0} outside any topic.{" "}
          <span className="text-muted-foreground">
            Finishing a tour never marks what is outside it as reviewed.
          </span>
        </p>
        <CoverageBar coverage={coverage} className="h-1.5" />
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {coverageSegments(coverage).map((segment) => (
            <li key={segment.key} className="flex items-center gap-1.5">
              <span className={cn("size-2 rounded-full", segment.className)} />
              {segment.label} · {segment.value}
            </li>
          ))}
        </ul>
      </header>
      <div className="space-y-4 p-6">
        {outside &&
          outsideFiles.map((file) => (
            <article
              key={file.path}
              className="flex min-w-0 items-center gap-3 rounded-3xl border p-4"
            >
              <ReviewStatus status="Uncovered" />
              <div className="min-w-0 flex-1">
                <p className="font-mono text-sm wrap-anywhere">{file.path}</p>
                <p className="text-xs text-muted-foreground">
                  {file.layers.join(" · ")} · {file.anchors.length} of{" "}
                  {file.total} changes outside the tour
                </p>
              </div>
              <Button
                size="xs"
                variant="secondary"
                onClick={() => onSelect(file.anchors[0])}
              >
                Review file
              </Button>
            </article>
          ))}
        {!outside &&
          files.map(({ change, passages }) => (
            <article key={change.id} className="rounded-3xl border">
              <div className="flex items-center gap-3 border-b p-2 pr-4">
                <FileRow
                  change={change}
                  className="min-w-0 flex-1"
                  onClick={() => onSelect(passages[0].anchor)}
                />
                <span className="flex gap-1" aria-hidden>
                  {passages.map((p) => (
                    <span
                      key={p.passage.id}
                      className={cn("size-2.5 rounded-[3px]", cell[p.status])}
                    />
                  ))}
                </span>
              </div>
              <ul className="divide-y">
                {passages
                  .filter((p) => !outside || !p.inTour)
                  .map((p) => (
                    <li
                      key={p.passage.id}
                      className="flex items-center gap-3 px-4 py-2.5 text-sm"
                    >
                      <ReviewStatus status={p.status} />
                      <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground">
                        {lineRange(p.passage)}
                      </span>
                      <span
                        className={cn(
                          "min-w-0 flex-1 truncate",
                          !p.inTour && "text-muted-foreground"
                        )}
                      >
                        {steps.get(p.passage.id) ?? "Outside the tour"}
                      </span>
                      <Button
                        size="xs"
                        variant={p.inTour ? "ghost" : "secondary"}
                        onClick={() => onSelect(p.anchor)}
                      >
                        {p.inTour ? "Open" : "Review here"}
                      </Button>
                    </li>
                  ))}
              </ul>
            </article>
          ))}
      </div>
    </section>
  )
}
