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
import { reviewIsComplete } from "../helpers/publication.helpers"

export function ReviewSummary({
  workspace,
  level,
  onReturn,
  onHome,
  busy,
  onAction,
}: {
  workspace: Workspace
  level: ReadingLevel
  onReturn: () => void
  onHome: () => void
  busy: boolean
  onAction: (action: ReviewAction) => void
}) {
  const [exporting, setExporting] = useState(false)
  const [message, setMessage] = useState("")
  const progress = guidedProgress(workspace.review)
  const complete = reviewIsComplete(workspace.review)
  return (
    <article className="mx-auto max-w-[720px] space-y-6 px-8 py-16">
      <p className="text-sm text-muted-foreground">
        <InlineMarkdown>{workspace.review.title}</InlineMarkdown>
      </p>
      <h1 className="text-3xl font-semibold tracking-tight">
        {complete ? "Review complete" : "Review summary"}
      </h1>
      <p className="text-base leading-7 text-muted-foreground">
        {progress.validated} of {progress.total} steps validated.
      </p>
      <ReviewPublicationDetails
        review={workspace.review}
        busy={busy}
        onAction={onAction}
      />
      <div className="flex flex-wrap gap-2">
        <Button variant={complete ? "secondary" : "default"} onClick={onReturn}>
          Back to review
        </Button>
        <Button variant={complete ? "default" : "secondary"} onClick={onHome}>
          Home
        </Button>
        <Button
          variant="ghost"
          disabled={exporting}
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
