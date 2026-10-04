"use client"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { CodeDiffEditor } from "@/features/code-editor/components/CodeDiffEditor"
import { errorMessage } from "@/lib/desktop/review.commands"
import { applyWorkspaceEdit, useLiveLanguages } from "../services/liveMonaco"

export function LanguageEditPreview() {
  const preview = useLiveLanguages((s) => s.edits)
  const [selected, setSelected] = useState(0)
  const [error, setError] = useState("")
  const file = preview?.files[selected] ?? preview?.files[0]
  return (
    <Dialog
      open={!!preview}
      onOpenChange={(open) => {
        if (!open) {
          useLiveLanguages.setState({ edits: null })
          setError("")
          setSelected(0)
        }
      }}
    >
      <DialogContent className="flex h-[80vh] max-w-[90vw] flex-col sm:max-w-[90vw]">
        <DialogTitle>Review code changes</DialogTitle>
        <DialogDescription>
          Changes will be applied to your open files. Your save preference still
          applies.
        </DialogDescription>
        <div className="flex flex-wrap gap-1">
          {preview?.files.map((f, index) => (
            <Button
              key={f.key}
              size="sm"
              variant={file?.key === f.key ? "secondary" : "ghost"}
              onClick={() => setSelected(index)}
            >
              {f.path}
            </Button>
          ))}
        </div>
        {file && (
          <div className="min-h-0 flex-1">
            <CodeDiffEditor
              height="100%"
              original={file.before}
              modified={file.after}
              options={{ readOnly: true }}
            />
          </div>
        )}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => useLiveLanguages.setState({ edits: null })}
          >
            Cancel
          </Button>
          <Button
            onClick={async () => {
              try {
                await applyWorkspaceEdit()
                setError("")
                setSelected(0)
              } catch (e) {
                setError(errorMessage(e))
              }
            }}
          >
            Apply changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
