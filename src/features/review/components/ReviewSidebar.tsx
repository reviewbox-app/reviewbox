"use client"
import { outsideReviewFiles } from "../helpers/review.helpers"
import { useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Add01Icon,
  AiMagicIcon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  Clock01Icon,
  Download01Icon,
  GitCommitIcon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
  Upload01Icon,
} from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type {
  CodeAnchor,
  Coverage,
  Workspace,
  Topic,
} from "@/lib/desktop/contracts.generated"
import { cn } from "@/lib/utils"
import { ReviewStatus } from "./ReviewStatus"
import { CoverageBar } from "./CoverageBar"
import { FileRow } from "./FileRow"
import {
  anchorFor,
  anchorLabel,
  isValidated,
  passageStatus,
  topicStatus,
  readingStep,
} from "../helpers/review.helpers"

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
  const reading = readingStep(review, selected)
  const current = reading?.topic
  const [open, setOpen] = useState<Set<string>>(
    () =>
      new Set(
        current ? [current.id] : review.topics.slice(0, 1).map((t) => t.id)
      )
  )
  const toggle = (id: string) =>
    setOpen((value) => {
      const next = new Set(value)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const taken = new Date(Number(snapshot.createdAt)).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  })
  return (
    <aside className="flex w-[272px] shrink-0 flex-col pt-2 pb-2 max-[1100px]:w-[220px]">
      <header className="px-3">
        <div className="flex items-center justify-between gap-2">
          <h1 className="truncate text-[17px] font-medium">{review.title}</h1>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Review actions"
                />
              }
            >
              <HugeiconsIcon icon={MoreHorizontalIcon} size={16} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onClick={onNew}>
                <HugeiconsIcon icon={Add01Icon} size={16} />
                New review
                <DropdownMenuShortcut>⌘N</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onPropose}>
                <HugeiconsIcon icon={AiMagicIcon} size={16} />
                Suggest topics with Rev
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onHistory}>
                <HugeiconsIcon icon={Clock01Icon} size={16} />
                Review history
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onImport}>
                <HugeiconsIcon icon={Download01Icon} size={16} />
                Import tour…
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onExport}>
                <HugeiconsIcon icon={Upload01Icon} size={16} />
                Export tour…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
          <HugeiconsIcon icon={GitCommitIcon} size={12} />
          Snapshot {snapshot.id.slice(0, 6)} · taken {taken}
        </p>
      </header>
      <div className="mt-5 flex items-center justify-between px-3">
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
      <nav
        aria-label="Reading path"
        className="mt-1 min-h-0 flex-1 overflow-auto px-1"
      >
        {review.topics.length === 0 && (
          <div className="px-2 py-2 text-sm leading-6 text-muted-foreground">
            <p>
              No topics yet. Read the files directly or build a guided path.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => onTopic()}>
                Create a topic
              </Button>
              <Button size="sm" variant="ghost" onClick={onPropose}>
                <HugeiconsIcon icon={AiMagicIcon} size={14} />
                Suggest with Rev
              </Button>
            </div>
          </div>
        )}
        {review.topics.map((topic) => {
          const statuses = topic.steps.map((step) =>
            step.anchors.length
              ? topicStatus(
                  step.anchors.map((a) => passageStatus(workspace, a))
                )
              : "Re-review"
          )
          // Progress counts human validations, even while a question is open.
          const done = topic.steps.filter(
            (step) =>
              step.anchors.length &&
              step.anchors.every((anchor) => {
                const passage = snapshot.changes
                  .find((c) => c.id === anchor?.changeId)
                  ?.passages.find((p) => p.id === anchor?.passageId)
                return (
                  !!anchor &&
                  !!passage &&
                  isValidated(review, anchor, passage.fingerprint)
                )
              })
          ).length
          const expanded = open.has(topic.id)
          return (
            <section key={topic.id} className="group/topic">
              <div className="relative">
                <button
                  aria-expanded={expanded}
                  onClick={() => toggle(topic.id)}
                  className="flex w-full items-center gap-2 rounded-xl py-1.5 pr-2 pl-1.5 text-left text-sm font-medium outline-none hover:bg-accent/60 focus-visible:ring-3 focus-visible:ring-ring/30"
                >
                  <HugeiconsIcon
                    icon={expanded ? ArrowDown01Icon : ArrowRight01Icon}
                    size={16}
                    className="shrink-0 text-muted-foreground"
                  />
                  <span className="min-w-0 flex-1 leading-5 wrap-anywhere">
                    {topic.title}
                  </span>
                  <span className="text-xs font-normal text-muted-foreground tabular-nums group-hover/topic:invisible">
                    {done}/{topic.steps.length}
                  </span>
                  <ReviewStatus status={topicStatus(statuses)} />
                </button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Edit ${topic.title}`}
                  className="invisible absolute top-1/2 right-7 -translate-y-1/2 group-hover/topic:visible focus-visible:visible"
                  onClick={() => onTopic(topic)}
                >
                  <HugeiconsIcon icon={PencilEdit02Icon} size={12} />
                </Button>
              </div>
              {expanded && (
                <ol className="mb-1 ml-3.5 space-y-0.5">
                  {topic.steps.map((step, index) => {
                    const anchor = step.anchors[0]
                    const active = reading?.step.id === step.id
                    return (
                      <li key={step.id}>
                        <button
                          aria-current={active ? "step" : undefined}
                          className={cn(
                            "flex w-full items-start gap-2.5 rounded-xl px-2 py-1.5 text-left outline-none hover:bg-accent/60 focus-visible:ring-3 focus-visible:ring-ring/30",
                            active && "bg-accent hover:bg-accent"
                          )}
                          onClick={() => anchor && onSelect(anchor, step.id)}
                        >
                          <span className="flex h-5 items-center">
                            <ReviewStatus status={statuses[index]} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span
                              className={cn(
                                "block text-sm leading-5 wrap-anywhere",
                                active && "font-medium"
                              )}
                            >
                              {step.title}
                            </span>
                            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                              {anchorLabel(workspace, anchor) ??
                                "Anchor needs attention"}
                            </span>
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ol>
              )}
            </section>
          )
        })}
        {review.topics.length === 0 && (
          <div className="mt-3 space-y-0.5">
            <h2 className="px-2 pb-1 text-xs text-muted-foreground">
              Changed files
            </h2>
            {snapshot.changes.map((change) => (
              <FileRow
                key={change.id}
                change={change}
                selected={selected?.changeId === change.id}
                onClick={() =>
                  onSelect(anchorFor(snapshot, change.id, change.passages[0]))
                }
              />
            ))}
          </div>
        )}
        <div className="mx-2 mt-3 border-t pt-3">
          <button
            onClick={onCoverage}
            className="-mx-1 flex w-[calc(100%+0.5rem)] items-center gap-2.5 rounded-xl px-2 py-1.5 text-left text-sm outline-none hover:bg-accent/60 focus-visible:ring-3 focus-visible:ring-ring/30"
          >
            <ReviewStatus status="Uncovered" />
            <span className="flex-1">
              {outsideReviewFiles(workspace).length} files with changes outside
              the tour
            </span>
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              size={16}
              className="text-muted-foreground"
            />
          </button>
        </div>
      </nav>
      <footer className="space-y-2 px-3 pt-3">
        <div className="flex flex-wrap justify-between gap-x-2 gap-y-1 text-xs">
          <span className="font-medium">Coverage</span>
          <span className="text-muted-foreground tabular-nums">
            {coverage?.examined ?? 0} of {coverage?.total ?? 0} passages
            reviewed
          </span>
        </div>
        <CoverageBar coverage={coverage} />
        <p className="flex items-center gap-1.5 pt-2 text-xs text-muted-foreground">
          <Kbd>J</Kbd>
          <Kbd>K</Kbd>
          next · previous step
        </p>
      </footer>
    </aside>
  )
}
