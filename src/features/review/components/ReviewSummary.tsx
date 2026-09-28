import { useState } from "react"
import { Button } from "@/components/ui/button"
import type { ReadingLevel, Workspace } from "@/lib/desktop/contracts.generated"
import { errorMessage } from "@/lib/desktop/review.commands"
import { guidedProgress } from "../helpers/review.helpers"
import { readerCommands } from "../services/reader.commands"

export function ReviewSummary({
  workspace,
  level,
  onReturn,
  onHome,
}: {
  workspace: Workspace
  level: ReadingLevel
  onReturn: () => void
  onHome: () => void
}) {
  const [exporting, setExporting] = useState(false)
  const [message, setMessage] = useState("")
  const progress = guidedProgress(workspace.review)
  return (
    <article className="mx-auto max-w-[720px] space-y-6 px-8 py-16">
      <p className="text-sm text-muted-foreground">{workspace.review.title}</p>
      <h1 className="text-3xl font-semibold tracking-tight">
        {progress.complete ? "Review complete" : "End of the tour"}
      </h1>
      <p className="text-base leading-7 text-muted-foreground">
        {progress.validated} of {progress.total} steps validated. File reviews
        are separate from this guided tour.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={onHome}>Home</Button>
        <Button variant="secondary" onClick={onReturn}>
          Back to review
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
    </article>
  )
}
