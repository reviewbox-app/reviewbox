import { HugeiconsIcon } from "@hugeicons/react"
import {
  InformationCircleIcon,
  CodeIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { ReviewMarkdown } from "@/features/markdown/components/ReviewMarkdown"
import type {
  CodeAnchor,
  DocumentReference,
  ReadingLevel,
  Workspace,
} from "@/lib/desktop/contracts.generated"
import { cn } from "@/lib/utils"
import {
  anchorLabel,
  authorOf,
  shortTime,
  type ReadingUnit,
} from "../helpers/review.helpers"

export function StepDocument({
  workspace,
  unit,
  index,
  total,
  selected,
  stale,
  validatedBy,
  compact = false,
  level,
  sourceMode,
  onOpenCode,
  onOpenReference,
}: {
  workspace: Workspace
  unit: ReadingUnit
  index: number
  total: number
  selected: CodeAnchor | null
  stale: boolean
  validatedBy?: { author: string; createdAt: string }
  compact?: boolean
  level: ReadingLevel
  sourceMode: "real" | "pseudo"
  onOpenCode: (anchor: CodeAnchor) => void
  onOpenReference: (reference: DocumentReference) => void
}) {
  const { step, topic } = unit.step
  const document = step.documents[level]
  return (
    <article
      className={cn(
        "min-w-0 wrap-anywhere",
        compact ? "space-y-4" : "space-y-6"
      )}
    >
      <header className="space-y-3">
        <p className="text-xs font-medium text-muted-foreground">
          Step {index + 1} of {total} · {topic.title} ·{" "}
          {Math.max(1, Math.ceil(document.readingSeconds / 60))} min read
        </p>
        <h1
          className={cn(
            "font-semibold tracking-tight",
            compact ? "text-xl leading-7" : "text-3xl leading-10"
          )}
        >
          {step.title}
        </h1>
        {validatedBy && (
          <Badge className="max-w-full bg-review-validated-soft whitespace-normal text-review-validated">
            <HugeiconsIcon icon={Tick02Icon} />
            Validated by {authorOf(validatedBy.author).name} ·{" "}
            {shortTime(validatedBy.createdAt)}
          </Badge>
        )}
      </header>
      {stale && (
        <Alert variant="faded" size="sm">
          <HugeiconsIcon icon={InformationCircleIcon} />
          <AlertDescription>
            Some references no longer match these review files. Refresh the
            review before validating this step.
          </AlertDescription>
        </Alert>
      )}
      <ReviewMarkdown
        key={`${workspace.snapshot.id}/${step.id}/${level}`}
        document={document}
        glossary={[
          ...(workspace.review.glossary ?? []),
          ...(step.documents.glossary ?? []),
        ]}
        level={level}
        reviewId={workspace.review.id}
        snapshotId={workspace.snapshot.id}
        files={workspace.review.files}
        sourceMode={sourceMode}
        onOpenReference={level === "beginner" ? undefined : onOpenReference}
        className={compact ? "text-sm leading-6" : "text-base leading-7"}
      />
      {level !== "beginner" && unit.anchors.length > 0 && (
        <section className="space-y-2" aria-label="Code for this step">
          <h2 className="text-xs font-medium text-muted-foreground">
            Code for this step
          </h2>
          <div className="flex flex-wrap gap-1.5">
            {unit.anchors.map((anchor) => (
              <Button
                key={`${anchor.changeId}/${anchor.passageId}`}
                size="xs"
                variant={
                  compact &&
                  selected?.passageId === anchor.passageId &&
                  selected.changeId === anchor.changeId
                    ? "default"
                    : "secondary"
                }
                className="max-w-full"
                onClick={() => onOpenCode(anchor)}
              >
                <HugeiconsIcon icon={CodeIcon} />
                <span className="truncate">
                  {anchorLabel(workspace, anchor) ?? "Passage"}
                </span>
              </Button>
            ))}
          </div>
        </section>
      )}
    </article>
  )
}
