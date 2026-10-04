"use client"
import { useCallback, useEffect, useRef } from "react"
import { useTheme } from "next-themes"
import type { editor } from "monaco-editor"
import { desktopAvailable } from "@/lib/desktop/review.commands"
import { Button } from "@/components/ui/button"
import { CodeEditor } from "../components/CodeEditor"
import { MarkdownPreviewToggle } from "@/features/markdown/components/MarkdownPreviewToggle"
import { DocumentDiffView } from "@/features/markdown/components/DocumentDiffView"
import { isDocumentFile } from "@/features/markdown/helpers/documentFiles.helpers"
import type {
  SourceViewHandle,
  SourceViewPosition,
} from "@/features/review/helpers/sourcePreviewSession"
import { reviewboxTheme } from "@/lib/monaco/reviewboxThemes"
import {
  dirty,
  bufferLanguage,
  editBuffer,
  getEditor,
  updateBuffer,
  type EditorBuffer,
} from "../stores/editor.store"
import {
  bindLiveEditor,
  restoreLanguageNavigation,
} from "@/features/language-servers/services/liveMonaco"
import { EditorLanguageStatus } from "@/features/language-servers/composites/EditorLanguageStatus"
import { useLanguageRegistry } from "@/features/language-servers/services/languageRegistry.service"

const previewStates = new Map<string, SourceViewPosition>()
const viewStates = new Map<string, editor.ICodeEditorViewState>()
export function EditorFileView({
  repositoryId,
  buffer,
  onSave,
  onConflict,
}: {
  repositoryId: string
  buffer: EditorBuffer
  onSave: () => void
  onConflict: () => void
}) {
  const { resolvedTheme } = useTheme()
  useLanguageRegistry((s) => s.registry)
  const instance = useRef<editor.IStandaloneCodeEditor | null>(null)
  const preview = useRef<SourceViewHandle>(null)
  const capturePreview = useCallback(
    (position: SourceViewPosition) => {
      previewStates.set(buffer.id, position)
    },
    [buffer.id]
  )
  const language = bufferLanguage(repositoryId, buffer)
  useEffect(
    () => () => {
      const view = instance.current?.saveViewState()
      if (view) viewStates.set(buffer.id, view)
      instance.current = null
    },
    [buffer.id, buffer.preview]
  )
  const revealNavigation = useCallback(
    (current: editor.IStandaloneCodeEditor) => {
      const session = getEditor(repositoryId)
      const latest = session?.buffers.find((item) => item.id === buffer.id)
      const navigation = latest?.navigation
      const model = current.getModel()
      if (
        !session ||
        !latest ||
        !navigation ||
        !model ||
        latest.preview ||
        session.active !== latest.path
      )
        return
      const range = model.validateRange({
        startLineNumber: navigation.line,
        startColumn: navigation.column,
        endLineNumber: navigation.line,
        endColumn: navigation.column + navigation.length,
      })
      current.setSelection(range)
      current.revealRangeInCenter(range)
      current.focus()
      updateBuffer(repositoryId, buffer.id, (item) =>
        item.navigation?.token === navigation.token
          ? { ...item, navigation: undefined }
          : item
      )
    },
    [repositoryId, buffer.id]
  )
  useEffect(() => {
    if (instance.current) revealNavigation(instance.current)
  }, [buffer.navigation?.token, revealNavigation])
  return (
    <section
      aria-label="Project file"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <header className="flex min-h-12 items-center gap-2 border-b px-3">
        <span className="min-w-0 flex-1 truncate text-sm" title={buffer.path}>
          {buffer.path}
        </span>
        {isDocumentFile(buffer.path, buffer.text.split("\n", 1)[0]) && (
          <MarkdownPreviewToggle
            active={buffer.preview}
            onToggle={() =>
              updateBuffer(repositoryId, buffer.id, (b) => ({
                ...b,
                preview: !b.preview,
              }))
            }
          />
        )}
        <Button
          size="sm"
          variant="ghost"
          aria-label="Find in file"
          onClick={() => {
            if (buffer.preview) preview.current?.find()
            else void instance.current?.getAction("actions.find")?.run()
          }}
        >
          Find
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={!dirty(buffer) || buffer.readOnly}
          onClick={onSave}
        >
          Save
        </Button>
      </header>
      {buffer.external !== undefined && (
        <div
          role="status"
          className="text-review-changed flex items-center gap-2 border-b px-3 py-2 text-sm"
        >
          <span>
            {buffer.external === null
              ? "This file was removed from disk. Your draft is kept."
              : "This file changed outside ReviewBox."}
          </span>
          <Button variant="ghost" size="sm" onClick={onConflict}>
            Compare changes
          </Button>
        </div>
      )}
      {buffer.reason && (
        <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
          {buffer.reason}
        </p>
      )}
      <div className="min-h-0 flex-1">
        {buffer.preview ? (
          <DocumentDiffView
            before={null}
            after={buffer.text}
            diff={false}
            split={false}
            padding={{ top: 16, bottom: 16 }}
            onCounts={() => {}}
            onCapture={capturePreview}
            saved={previewStates.get(buffer.id)}
            point={previewStates.get(buffer.id)?.point}
            handle={preview}
            onCode={() =>
              updateBuffer(repositoryId, buffer.id, (b) => ({
                ...b,
                preview: false,
              }))
            }
          />
        ) : (
          <CodeEditor
            path={`reviewbox-editor://${repositoryId}/${buffer.id}`}
            keepCurrentModel
            saveViewState
            value={buffer.text}
            language={language}
            height="100%"
            theme={reviewboxTheme(resolvedTheme !== "light")}
            onChange={(value) => {
              if (value !== undefined && !buffer.readOnly)
                editBuffer(repositoryId, buffer.id, value)
            }}
            options={{
              readOnly: buffer.readOnly,
              automaticLayout: true,
              minimap: { enabled: false },
              fontSize: 12,
              lineHeight: 20,
              fontLigatures: false,
              fontFamily: "var(--font-mono)",
              padding: { top: 16, bottom: 16 },
              wordWrap: "on",
              scrollBeyondLastLine: false,
            }}
            onMount={(current, monaco) => {
              instance.current = current
              const model = current.getModel()
              if (model && desktopAvailable())
                bindLiveEditor(monaco, model, repositoryId, buffer)
              const state = viewStates.get(buffer.id)
              if (state) current.restoreViewState(state)
              restoreLanguageNavigation(current)
              revealNavigation(current)
              current.focus()
            }}
          />
        )}
      </div>
      <footer className="flex min-h-7 flex-wrap items-center gap-2 border-t px-3 text-xs text-muted-foreground">
        <EditorLanguageStatus repositoryId={repositoryId} buffer={buffer} />
        <span>{dirty(buffer) ? "Unsaved changes" : "Saved"}</span>
      </footer>
    </section>
  )
}
