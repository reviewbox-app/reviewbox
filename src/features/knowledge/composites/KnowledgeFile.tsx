"use client"

import { useCallback, useLayoutEffect, useRef, useState } from "react"
import type { editor } from "monaco-editor"
import { useTheme } from "next-themes"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CodeEditor } from "@/features/code-editor/components/CodeEditor"
import { FileIcon } from "@/features/file-icons/components/FileIcon"
import { DocumentDiffView } from "@/features/markdown/components/DocumentDiffView"
import { MarkdownPreviewToggle } from "@/features/markdown/components/MarkdownPreviewToggle"
import { isDocumentFile } from "@/features/markdown/helpers/documentFiles.helpers"
import { sameReadingPoint } from "@/features/markdown/helpers/documentPosition.helpers"
import {
  languageFor,
  languageName,
} from "@/features/review/helpers/review.helpers"
import {
  sourcePreviewSession,
  updateSourcePreviewSession,
  type SourceMode,
  type SourceViewHandle,
  type SourceViewPosition,
} from "@/features/review/helpers/sourcePreviewSession"
import type { Snapshot } from "@/lib/desktop/contracts.generated"
import { reviewboxTheme } from "@/lib/monaco/reviewboxThemes"
import { Search01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

const padding = { top: 16, bottom: 16 }
const ignoreCounts = () => {}

/** A current captured file, using the same document renderer and toggle as Review. */
export function KnowledgeFile({
  snapshot,
  file,
  code,
}: {
  snapshot: Pick<Snapshot, "id" | "repositoryId">
  file: Snapshot["files"][number]
  code: string
}) {
  const { path } = file
  const sessionKey = `explain/${snapshot.repositoryId}/${path}/${file.content.hash}`
  const session = sourcePreviewSession(sessionKey)
  const [mode, setMode] = useState<SourceMode>(session.mode ?? "markdown")
  const compatible = isDocumentFile(path, code.split("\n", 1)[0])
  const markdown = compatible && mode === "markdown"
  const document = useRef<SourceViewHandle>(null)
  const source = useRef<editor.IStandaloneCodeEditor | null>(null)
  const cleanup = useRef<(() => void) | null>(null)
  const frame = useRef<number | null>(null)
  const { resolvedTheme } = useTheme()
  const folder = path.split("/").slice(0, -1).join("/")
  const capture = useCallback(
    (position: SourceViewPosition, mode: SourceMode) => {
      updateSourcePreviewSession(sessionKey, {
        [mode]: position,
        point: position.point,
      })
    },
    [sessionKey]
  )
  const captureMarkdown = useCallback(
    (position: SourceViewPosition) => capture(position, "markdown"),
    [capture]
  )
  const captureCode = useCallback(() => {
    const current = source.current
    if (!current) return
    const offset = current.getScrollTop() + padding.top
    const max = current.getModel()?.getLineCount() ?? 1
    let line = current.getVisibleRanges()[0]?.startLineNumber ?? 1
    while (line < max && current.getBottomForLineNumber(line) <= offset) line++
    const top = current.getTopForLineNumber(line)
    const height = Math.max(1, current.getBottomForLineNumber(line) - top)
    capture(
      {
        point: {
          side: "after",
          line,
          fraction: Math.max(0, Math.min(1, (offset - top) / height)),
        },
        split: false,
        singleCode: current.saveViewState(),
      },
      "code"
    )
  }, [capture])
  const stopCode = useCallback(() => {
    captureCode()
    cleanup.current?.()
    cleanup.current = null
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
    source.current = null
  }, [captureCode])
  useLayoutEffect(() => stopCode, [stopCode])
  const switchMode = () => {
    if (markdown) {
      const position = document.current?.capture()
      if (position) captureMarkdown(position)
    } else stopCode()
    const next = markdown ? "code" : "markdown"
    updateSourcePreviewSession(sessionKey, { mode: next })
    setMode(next)
  }
  return (
    <section
      aria-label="Project file"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
        <FileIcon path={path} />
        <span className="min-w-0 flex-1 basis-20 truncate text-sm" title={path}>
          {folder && <span className="text-muted-foreground">{folder}/</span>}
          <span className="font-medium">{path.split("/").at(-1)}</span>
        </span>
        <Badge variant="secondary">
          {markdown ? "Markdown" : languageName(path)}
        </Badge>
        <span className="flex-1" />
        {compatible && (
          <MarkdownPreviewToggle active={markdown} onToggle={switchMode} />
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Find in file"
          onClick={() => {
            if (markdown) document.current?.find()
            else void source.current?.getAction("actions.find")?.run()
          }}
        >
          <HugeiconsIcon icon={Search01Icon} size={16} />
        </Button>
      </header>
      <div className="min-h-0 flex-1">
        {markdown ? (
          <DocumentDiffView
            before={null}
            after={code}
            diff={false}
            split={false}
            padding={padding}
            point={session.point}
            saved={session.markdown}
            onCapture={captureMarkdown}
            onCounts={ignoreCounts}
            onCode={switchMode}
            handle={document}
          />
        ) : (
          <CodeEditor
            height="100%"
            value={code}
            path={`reviewbox://current/${snapshot.repositoryId}/understand/${file.content.hash}/${path}`}
            languageDocument={{
              snapshotId: snapshot.id,
              path,
              changeId: null,
              side: null,
              contentHash: file.content.hash,
            }}
            language={languageFor(path)}
            theme={reviewboxTheme(resolvedTheme !== "light")}
            options={{
              readOnly: true,
              automaticLayout: true,
              minimap: { enabled: false },
              fontSize: 12,
              lineHeight: 20,
              fontLigatures: false,
              fontFamily: "var(--font-mono)",
              padding,
              folding: false,
              renderLineHighlight: "none",
              wordWrap: "on",
              wrappingIndent: "same",
              scrollBeyondLastLine: false,
              scrollbar: {
                verticalScrollbarSize: 8,
                horizontalScrollbarSize: 8,
              },
            }}
            onMount={(current) => {
              source.current = current
              frame.current = requestAnimationFrame(() => {
                frame.current = null
                if (source.current !== current) return
                current.layout()
                const state = sourcePreviewSession(sessionKey)
                if (
                  state.code?.singleCode &&
                  sameReadingPoint(state.point, state.code.point)
                )
                  current.restoreViewState(state.code.singleCode)
                else if (state.point) {
                  const line = Math.max(
                    1,
                    Math.min(
                      state.point.line,
                      current.getModel()?.getLineCount() ?? 1
                    )
                  )
                  const top = current.getTopForLineNumber(line)
                  current.setScrollTop(
                    Math.max(
                      0,
                      top +
                        state.point.fraction *
                          (current.getBottomForLineNumber(line) - top) -
                        padding.top
                    )
                  )
                }
                const subscription = current.onDidScrollChange(captureCode)
                cleanup.current = () => subscription.dispose()
              })
            }}
          />
        )}
      </div>
    </section>
  )
}
