import { Button } from "@/components/ui/button"
import { HugeiconsIcon } from "@hugeicons/react"
import { Add01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons"
import type {
  CodeAnchor,
  Coverage,
  Workspace,
  Topic,
} from "@/lib/desktop/contracts.generated"
import { ReviewStatus } from "./ReviewStatus"
import { passageStatus, anchorFor } from "../helpers/review.helpers"
import { cn } from "@/lib/utils"

export function ReviewSidebar({
  workspace,
  coverage,
  selected,
  onSelect,
  onTopic,
  onCoverage,
  onNew,
  onExport,
  onImport,
  onHistory,
  onPropose,
}: {
  workspace: Workspace
  coverage: Coverage | null
  selected: CodeAnchor | null
  onSelect: (anchor: CodeAnchor, stepId?: string) => void
  onTopic: (topic?: Topic) => void
  onCoverage: () => void
  onNew: () => void
  onExport: () => void
  onImport: () => void
  onHistory: () => void
  onPropose: () => void
}) {
  const { review, snapshot } = workspace
  return (
    <aside className="flex w-[272px] shrink-0 flex-col gap-4 px-1 pt-2 pb-2 max-[1100px]:w-[210px]">
      <div className="px-2">
        <div className="flex items-center justify-between">
          <h1 className="truncate text-base font-medium">{review.title}</h1>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="New review"
            onClick={onNew}
          >
            <HugeiconsIcon icon={Add01Icon} size={14} />
          </Button>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Snapshot {snapshot.id.slice(0, 6)} ·{" "}
          {new Date(Number(snapshot.createdAt)).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </p>
      </div>
      <div className="flex items-center justify-between px-2">
        <h2 className="text-xs text-muted-foreground">Topics</h2>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Add topic"
          onClick={() => onTopic()}
        >
          <HugeiconsIcon icon={Add01Icon} size={14} />
        </Button>
      </div>
      <Button variant="outline" size="sm" onClick={onPropose}>
        Agent proposals
      </Button>
      <div className="min-h-0 flex-1 space-y-2 overflow-auto">
        {review.topics.length === 0 && (
          <div className="px-2 text-sm leading-6 text-muted-foreground">
            <p>No topics yet. Read changes directly or build a guided path.</p>
            <Button
              className="mt-3"
              variant="outline"
              size="sm"
              onClick={() => onTopic()}
            >
              Create a topic
            </Button>
          </div>
        )}
        {review.topics.map((topic) => (
          <section key={topic.id}>
            <button
              className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm font-medium hover:bg-accent"
              onClick={() => onTopic(topic)}
            >
              <HugeiconsIcon icon={ArrowRight01Icon} size={14} />
              <span className="flex-1">{topic.title}</span>
              <span className="text-xs text-muted-foreground">
                {topic.steps.length}
              </span>
            </button>
            <div className="ml-4 space-y-1">
              {topic.steps.map((step) => {
                const anchor = step.anchors[0]
                const change = snapshot.changes.find(
                  (c) => c.id === anchor?.changeId
                )
                return (
                  <button
                    key={step.id}
                    className={cn(
                      "flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left hover:bg-accent",
                      selected?.passageId === anchor?.passageId && "bg-accent"
                    )}
                    onClick={() => anchor && onSelect(anchor, step.id)}
                  >
                    <ReviewStatus
                      status={
                        anchor ? passageStatus(workspace, anchor) : "Re-review"
                      }
                    />
                    <span className="min-w-0">
                      <span className="block text-sm">{step.title}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {change?.path ?? "Anchor needs attention"}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          </section>
        ))}
        <div className="mt-4 border-t pt-3">
          <button
            onClick={onCoverage}
            className="w-full px-2 text-left text-xs text-muted-foreground"
          >
            {coverage?.outside ?? 0} changes outside the tour
          </button>
          {snapshot.changes.map((change) => (
            <button
              key={change.id}
              className={cn(
                "mt-1 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs hover:bg-accent",
                selected?.changeId === change.id && "bg-accent"
              )}
              onClick={() =>
                onSelect(anchorFor(snapshot, change.id, change.passages[0]))
              }
            >
              <span className="min-w-0 flex-1 truncate">{change.path}</span>
              <span className="text-[10px] text-muted-foreground">
                {change.layer}
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-2 px-2">
        <div className="flex justify-between text-xs">
          <span>Coverage</span>
          <span className="text-muted-foreground">
            {coverage?.validated ?? 0} of {coverage?.total ?? 0} validated
          </span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-review-validated transition-[width]"
            style={{
              width: `${coverage?.total ? (coverage.validated / coverage.total) * 100 : 0}%`,
            }}
          />
        </div>
        <Button
          variant="ghost"
          size="xs"
          className="w-full"
          onClick={onHistory}
        >
          Review history
        </Button>
        <div className="flex justify-between">
          <Button variant="ghost" size="xs" onClick={onImport}>
            Import tour
          </Button>
          <Button variant="ghost" size="xs" onClick={onExport}>
            Export
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground">
          J K · next / previous passage
        </p>
      </div>
    </aside>
  )
}
