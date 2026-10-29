"use client"
import { useEffect, useRef, useState } from "react"
import type * as M from "monaco-editor/editor/editor.api"
import { CodeEditor } from "@/features/code-editor/components/CodeEditor"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { errorMessage } from "@/lib/desktop/review.commands"
import { liveCommands } from "../services/liveLanguage.commands"
import {
  bindInspection,
  type InspectionDocument,
  type InspectionTarget,
} from "../services/inspectionMonaco"
import type { EditorFile } from "@/lib/desktop/contracts.generated"

export function useSourceInspection(document?: InspectionDocument) {
  const cleanup = useRef<{ dispose(): void } | null>(null)
  const [target, setTarget] = useState<InspectionTarget>()
  const [source, setSource] = useState<{
    target: InspectionTarget
    file: EditorFile
  }>()
  const [error, setError] = useState("")
  useEffect(() => () => cleanup.current?.dispose(), [])
  useEffect(() => {
    if (!target) return
    let alive = true
    void liveCommands
      .source(target.sessionId, target.uri)
      .then((file) => {
        if (alive) setSource({ target, file })
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e))
      })
    return () => {
      alive = false
    }
  }, [target])
  return {
    bind(model: M.editor.ITextModel, monaco: typeof M) {
      cleanup.current?.dispose()
      cleanup.current = document
        ? bindInspection(
            monaco,
            model,
            document,
            (value) => {
              setError("")
              setTarget(value)
            },
            setError
          )
        : null
    },
    exploration: (
      <>
        {error && !target && (
          <p
            role="status"
            className="absolute right-3 bottom-14 z-30 max-w-sm rounded bg-popover p-2 text-xs"
          >
            {error}
          </p>
        )}
        <Dialog
          open={!!target}
          onOpenChange={(open) => {
            if (!open) setTarget(undefined)
          }}
        >
          <DialogContent className="flex h-[80vh] flex-col sm:max-w-5xl">
            <DialogHeader>
              <DialogTitle>Source definition</DialogTitle>
              <DialogDescription>
                Read-only inspection using the current project configuration.
              </DialogDescription>
            </DialogHeader>
            {error ? (
              <p role="alert">{error}</p>
            ) : source?.target === target && source ? (
              <CodeEditor
                path={`reviewbox-inspection-source://${source.file.path}`}
                sourcePath={source.file.path}
                value={source.file.text}
                height="100%"
                options={{ readOnly: true, minimap: { enabled: false } }}
                onMount={(editor) => {
                  if (target) {
                    const r = target.range
                    editor.setSelection({
                      startLineNumber: r.start.line + 1,
                      startColumn: r.start.character + 1,
                      endLineNumber: r.end.line + 1,
                      endColumn: r.end.character + 1,
                    })
                    editor.revealLineInCenter(r.start.line + 1)
                  }
                }}
              />
            ) : (
              <p role="status">Loading source…</p>
            )}
          </DialogContent>
        </Dialog>
      </>
    ),
  }
}
