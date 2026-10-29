import { InlineMarkdown } from "@/features/markdown/components/InlineMarkdown"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import type {
  ReadingLevel,
  ReviewAction,
  Workspace,
} from "@/lib/desktop/contracts.generated"
import { errorMessage } from "@/lib/desktop/review.commands"
import { guidedProgress, stepDecision } from "../helpers/review.helpers"
import { readerCommands } from "../services/reader.commands"
import { ReviewPublicationDetails } from "./ReviewPublicationDetails"
import {
  reviewIsComplete,
  reviewIsFinalized,
} from "../helpers/publication.helpers"
import type { ReviewCommentsSession } from "../hooks/useReviewComments"
import { ReviewCommentsSummary } from "./ReviewCommentsSummary"
import { WorkingContextStatus } from "@/features/agents/components/WorkingContextStatus"
import { ReviewFinalization } from "../composites/ReviewFinalization"
import type { ReviewFinalizationSession } from "../hooks/useReviewFinalization"
import { ReviewCommit } from "@/features/source-control/composites/ReviewCommit"

export function ReviewSummary({
  workspace,
  level,
  onReturn,
  onHome,
  busy,
  onAction,
  comments,
  finalization,
  finalizationStarting = false,
  onConfigure,
  onFinish,
  hasLocalChanges,
}: {
  workspace: Workspace
  level: ReadingLevel
  onReturn: () => void
  onHome: () => void
  busy: boolean
  onAction: (action: ReviewAction) => void
  comments?: ReviewCommentsSession
  finalization?: ReviewFinalizationSession
  finalizationStarting?: boolean
  onConfigure?: () => void
  onFinish?: () => void
  hasLocalChanges?: boolean
}) {
  const [exporting, setExporting] = useState(false)
  const [message, setMessage] = useState("")
  const progress = guidedProgress(workspace.review)
  const complete = reviewIsComplete(workspace.review)
  const finalizing = finalizationStarting || finalization?.active
  const checkingFinalization = finalization?.checking
  const finalizationFailed =
    !!finalization?.error ||
    finalization?.operation?.status === "failed" ||
    finalization?.operation?.status === "interrupted"
  return (
    <article className="mx-auto max-w-[720px] space-y-6 px-8 py-16">
      <p className="text-sm text-muted-foreground">
        <InlineMarkdown>{workspace.review.title}</InlineMarkdown>
      </p>
      <h1 className="text-3xl font-semibold tracking-tight">
        {finalizing
          ? "Finalizing review"
          : finalizationFailed
            ? "Review needs attention"
            : complete && !checkingFinalization
              ? "Review complete"
              : "Review summary"}
      </h1>
      {workspace.review.mode !== "manual" && (
        <p className="text-base leading-7 text-muted-foreground">
          {progress.validated} of {progress.total} steps validated.
        </p>
      )}
      <ReviewFinalization
        review={workspace.review}
        session={finalization}
        starting={finalizationStarting}
        onAction={onAction}
      />
      {reviewIsFinalized(workspace.review) &&
        !finalizing &&
        !finalizationFailed &&
        !checkingFinalization && (
          <ReviewCommit
            repositoryId={workspace.review.repositoryId}
            reviewId={workspace.review.id}
            onConfigure={onConfigure}
            onFinish={onFinish}
            hasChanges={hasLocalChanges}
          />
        )}
      <ReviewPublicationDetails
        review={workspace.review}
        busy={busy}
        onAction={onAction}
      />
      {!finalizing && !checkingFinalization && (
        <WorkingContextStatus
          repositoryId={workspace.review.repositoryId}
          reviewId={workspace.review.id}
          revision={workspace.review.revision}
          completed={complete}
        />
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant={complete || finalizing ? "secondary" : "default"}
          onClick={onReturn}
        >
          Back to review
        </Button>
        <Button variant="secondary" onClick={onHome}>
          Back home
        </Button>
        <Button
          variant="ghost"
          disabled={exporting || !!finalizing}
          onClick={async () => {
            setExporting(true)
            setMessage("")
            try {
              if (
                await readerCommands.exportSummary(workspace.review.id, level)
              )
                setMessage("Summary exported.")
            } catch (cause) {
              setMessage(errorMessage(cause))
            } finally {
              setExporting(false)
            }
          }}
        >
          {exporting ? "Exporting…" : "Export Markdown"}
        </Button>
      </div>
      {message && (
        <p role="status" className="text-sm text-muted-foreground">
          {message}
        </p>
      )}
      {workspace.review.mode === "manual" && comments && (
        <ReviewCommentsSummary
          session={comments}
          snapshotId={workspace.snapshot.id}
        />
      )}
      <section
        aria-label="Changes in this review"
        className="space-y-8 border-t pt-6"
      >
        <h2 className="text-lg font-semibold">Changes in this review</h2>
        <ul className="space-y-2">
          {workspace.review.topics
            .flatMap((topic) => topic.steps)
            .map((step) => {
              const validated = !!stepDecision(workspace.review, step.id)
              const examined = workspace.review.decisions.some(
                (decision) =>
                  decision.target.kind === "step" &&
                  decision.target.stepId === step.id &&
                  decision.state === "examined"
              )
              return (
                <li
                  key={step.id}
                  className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm"
                >
                  <span className="min-w-0 flex-1">
                    <InlineMarkdown>{step.title}</InlineMarkdown>
                  </span>
                  <span
                    className={
                      validated
                        ? "text-review-validated"
                        : "text-muted-foreground"
                    }
                  >
                    {validated
                      ? "Validated"
                      : examined
                        ? "Examined"
                        : "To review"}
                  </span>
                </li>
              )
            })}
        </ul>
      </section>
    </article>
  )
}
