"use client"
import { reviewReaderLayout } from "../reader.config"

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type Ref,
} from "react"
import type { editor } from "monaco-editor"
import { useTheme } from "next-themes"
import { CodeDiffEditor } from "@/features/code-editor/components/CodeDiffEditor"
import type { SourceReadingPoint } from "@/features/markdown/contracts/documentDiff.types"
import type {
  Change,
  CodeAnchor,
  FileContent,
  Passage,
  ReadingPosition,
  Snapshot,
} from "@/lib/desktop/contracts.generated"
import { reviewboxTheme } from "@/lib/monaco/reviewboxThemes"
import { languageFor } from "../helpers/review.helpers"
import { sameReadingPoint } from "@/features/markdown/helpers/documentPosition.helpers"
import { revealPassage } from "../helpers/revealPassage.helpers"
import {
  type SourceViewHandle,
  type SourceViewPosition,
} from "../helpers/sourcePreviewSession"

export function ReviewSourceCode({
  snapshot,
  change,
  content,
  passage,
  selection,
  position,
  onPosition,
  split,
  trimWhitespace,
  padding,
  modelScope,
  point,
  saved,
  onCapture,
  onCounts,
  onCursor,
  handle,
}: {
  snapshot: Pick<Snapshot, "id">
  change: Change
  content: FileContent
  passage?: Passage
  selection: CodeAnchor | null
  position: ReadingPosition
  onPosition: (position: ReadingPosition) => void
  split: boolean
  trimWhitespace: boolean
  padding: { top: number; bottom: number }
  modelScope: "reader" | "reference" | "local"
  point?: SourceReadingPoint
  saved?: SourceViewPosition
  onCapture: (value: SourceViewPosition) => void
  onCounts: (value: { added: number; removed: number }) => void
  onCursor: (value: { line: number; column: number }) => void
  handle: Ref<SourceViewHandle>
}) {
  const { resolvedTheme } = useTheme()
  const instance = useRef<editor.IStandaloneDiffEditor | null>(null)
  const cleanup = useRef<(() => void) | null>(null)
  const revealFrame = useRef<number | null>(null)
  const marks = useRef<{
    before: editor.IEditorDecorationsCollection
    after: editor.IEditorDecorationsCollection
  } | null>(null)
  const revealed = useRef(selection)
  const latest = useRef({
    hasAfter: content.after !== null,
    passage,
    selection,
    padding,
    split,
    position,
    onPosition,
    onCapture,
    onCounts,
    onCursor,
  })
  const initial = useRef({ point, saved })
  const ready = useRef(false)
  useLayoutEffect(() => {
    latest.current = {
      hasAfter: content.after !== null,
      passage,
      selection,
      padding,
      split,
      position,
      onPosition,
      onCapture,
      onCounts,
      onCursor,
    }
  })

  const capture = useCallback((): SourceViewPosition | undefined => {
    const diff = instance.current
    if (!diff || !ready.current) return
    const original = diff.getOriginalEditor()
    const before =
      !latest.current.hasAfter ||
      (latest.current.split &&
        (original.hasTextFocus() || initial.current.point?.side === "before"))
    const source = before ? original : diff.getModifiedEditor()
    const offset = source.getScrollTop() + latest.current.padding.top
    const max = source.getModel()?.getLineCount() ?? 1
    let line = source.getVisibleRanges()[0]?.startLineNumber ?? 1
    while (line < max && source.getBottomForLineNumber(line) <= offset) line++
    const top = source.getTopForLineNumber(line)
    const height = Math.max(1, source.getBottomForLineNumber(line) - top)
    return {
      point: {
        side: before ? "before" : "after",
        line,
        fraction: Math.max(0, Math.min(1, (offset - top) / height)),
      },
      split: latest.current.split,
      code: diff.saveViewState(),
    }
  }, [])
  useImperativeHandle(
    handle,
    () => ({
      capture,
      find: () => {
        void instance.current
          ?.getModifiedEditor()
          .getAction("actions.find")
          ?.run()
      },
    }),
    [capture]
  )

  const decorate = useCallback(() => {
    marks.current?.before.clear()
    marks.current?.after.clear()
    const target = latest.current.passage
    if (!target) return
    const start = target.newLines ? target.newStart : target.oldStart
    const side = target.newLines ? marks.current?.after : marks.current?.before
    side?.set([
      {
        range: {
          startLineNumber: start,
          endLineNumber:
            start + Math.max(target.newLines || target.oldLines, 1) - 1,
          startColumn: 1,
          endColumn: 1,
        },
        options: {
          isWholeLine: true,
          className: "review-passage",
          marginClassName: "review-passage-margin",
        },
      },
    ])
  }, [])
  const scheduleReveal = useCallback(
    (restore = false) => {
      if (revealFrame.current !== null)
        cancelAnimationFrame(revealFrame.current)
      revealFrame.current = requestAnimationFrame(() => {
        revealFrame.current = null
        const diff = instance.current
        if (!diff) return
        diff.layout()
        const { point, saved } = initial.current
        const { passage, padding, position, split } = latest.current
        if (restore && point) {
          if (
            saved?.code &&
            saved.split === split &&
            sameReadingPoint(point, saved.point)
          )
            diff.restoreViewState(saved.code)
          else {
            const source =
              point.side === "before"
                ? diff.getOriginalEditor()
                : diff.getModifiedEditor()
            const line = Math.max(
              1,
              Math.min(point.line, source.getModel()?.getLineCount() ?? 1)
            )
            const top = source.getTopForLineNumber(line)
            source.setScrollTop(
              Math.max(
                0,
                top +
                  point.fraction * (source.getBottomForLineNumber(line) - top) -
                  padding.top
              )
            )
          }
        } else if (
          restore &&
          modelScope !== "reference" &&
          position.changeId === change.id &&
          (!passage || position.passageId === passage.id) &&
          position.line > 0
        ) {
          diff
            .getModifiedEditor()
            .setPosition({ lineNumber: position.line, column: 1 })
          diff.getModifiedEditor().setScrollTop(position.scrollTop)
        } else if (passage) {
          const start = passage.newLines ? passage.newStart : passage.oldStart
          revealPassage(
            passage.newLines
              ? diff.getModifiedEditor()
              : diff.getOriginalEditor(),
            start,
            start + Math.max(passage.newLines || passage.oldLines, 1) - 1,
            padding
          )
        }
        ready.current = true
      })
    },
    [change.id, modelScope]
  )
  useEffect(() => {
    if (!instance.current || revealed.current === selection) return
    revealed.current = selection
    initial.current = { point: undefined, saved: undefined }
    decorate()
    scheduleReveal()
  }, [selection, decorate, scheduleReveal])
  useLayoutEffect(
    () => () => {
      const value = capture()
      if (value) latest.current.onCapture(value)
      if (revealFrame.current !== null)
        cancelAnimationFrame(revealFrame.current)
      cleanup.current?.()
      cleanup.current = null
      instance.current = null
    },
    [capture]
  )
  return (
    <CodeDiffEditor
      height="100%"
      overlayTop={Math.max(0, padding.top - reviewReaderLayout.contentInset)}
      original={content.before ?? ""}
      modified={content.after ?? ""}
      originalLanguageDocument={
        change.before && modelScope !== "local"
          ? {
              snapshotId: snapshot.id,
              path: change.previousPath ?? change.path,
              changeId: change.id,
              side: "before",
              contentHash: change.before.hash,
            }
          : undefined
      }
      modifiedLanguageDocument={
        change.after && modelScope !== "local"
          ? {
              snapshotId: snapshot.id,
              path: change.path,
              changeId: change.id,
              side: "after",
              contentHash: change.after.hash,
            }
          : undefined
      }
      language={languageFor(change.path)}
      originalModelPath={`reviewbox://${snapshot.id}/${change.id}/${modelScope}/before/${change.path}`}
      modifiedModelPath={`reviewbox://${snapshot.id}/${change.id}/${modelScope}/after/${change.path}`}
      theme={reviewboxTheme(resolvedTheme !== "light")}
      options={{
        readOnly: true,
        ignoreTrimWhitespace: trimWhitespace,
        originalEditable: false,
        renderSideBySide: split,
        useInlineViewWhenSpaceIsLimited: false,
        automaticLayout: true,
        minimap: { enabled: false },
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        lineHeight: 20,
        fontLigatures: false,
        wordWrap: "on",
        diffWordWrap: "on",
        wrappingIndent: "same",
        scrollBeyondLastLine: false,
        padding,
        hideUnchangedRegions: { enabled: false },
        renderOverviewRuler: false,
        renderIndicators: true,
        glyphMargin: false,
        folding: false,
        lineDecorationsWidth: 12,
        scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
      }}
      onMount={(mounted) => {
        instance.current = mounted
        const original = mounted.getOriginalEditor(),
          modified = mounted.getModifiedEditor()
        marks.current = {
          before: original.createDecorationsCollection(),
          after: modified.createDecorationsCollection(),
        }
        revealed.current = latest.current.selection
        decorate()
        scheduleReveal(true)
        let initialDiff = true
        const subscriptions = [
          mounted.onDidUpdateDiff(() => {
            if (initialDiff) {
              initialDiff = false
              scheduleReveal(true)
            }
            let added = 0,
              removed = 0
            for (const value of mounted.getLineChanges() ?? []) {
              if (value.modifiedEndLineNumber > 0)
                added +=
                  value.modifiedEndLineNumber -
                  value.modifiedStartLineNumber +
                  1
              if (value.originalEndLineNumber > 0)
                removed +=
                  value.originalEndLineNumber -
                  value.originalStartLineNumber +
                  1
            }
            latest.current.onCounts({ added, removed })
          }),
        ]
        let timer: ReturnType<typeof setTimeout> | undefined
        const persist = () => {
          const value = capture()
          if (!value) return
          latest.current.onCapture(value)
          clearTimeout(timer)
          timer = setTimeout(
            () =>
              latest.current.onPosition({
                ...latest.current.position,
                changeId: change.id,
                passageId: latest.current.passage?.id ?? null,
                line: modified.getPosition()?.lineNumber ?? 1,
                scrollTop: modified.getScrollTop(),
                split: latest.current.split,
              }),
            500
          )
        }
        subscriptions.push(
          modified.onDidScrollChange(persist),
          original.onDidScrollChange(persist),
          modified.onDidChangeCursorPosition((event) => {
            latest.current.onCursor({
              line: event.position.lineNumber,
              column: event.position.column,
            })
            persist()
          })
        )
        cleanup.current = () => {
          clearTimeout(timer)
          subscriptions.forEach((item) => item.dispose())
          marks.current?.before.clear()
          marks.current?.after.clear()
          marks.current = null
        }
      }}
    />
  )
}
