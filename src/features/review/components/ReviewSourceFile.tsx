"use client"

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type ComponentProps,
} from "react"
import type { editor } from "monaco-editor"
import { useTheme } from "next-themes"
import { CodeEditor } from "@/features/code-editor/components/CodeEditor"
import { observeSourceSelection } from "@/features/code-editor/services/sourceSelection"
import { reviewboxTheme } from "@/lib/monaco/reviewboxThemes"
import { sameReadingPoint } from "@/features/markdown/helpers/documentPosition.helpers"
import { languageFor } from "../helpers/review.helpers"
import { revealPassage } from "../helpers/revealPassage.helpers"
import type { SourceViewPosition } from "../helpers/sourcePreviewSession"
import { reviewReaderLayout } from "../reader.config"
import type { ReviewSourceCode } from "./ReviewSourceCode"

/** Added and deleted files have one captured version to read. */
export function ReviewSourceFile(
  props: ComponentProps<typeof ReviewSourceCode>
) {
  const { snapshot, change, content, padding, modelScope, handle, onCounts } =
    props
  const side = change.after ? "after" : "before"
  const text = content[side] ?? ""
  const file = change[side]
  const path =
    side === "before" ? (change.previousPath ?? change.path) : change.path
  const { resolvedTheme } = useTheme()
  const instance = useRef<editor.IStandaloneCodeEditor | null>(null)
  const marker = useRef<editor.IEditorDecorationsCollection | null>(null)
  const cleanup = useRef<(() => void) | null>(null)
  const frame = useRef<number | null>(null)
  const ready = useRef(false)
  const latest = useRef(props)
  const revealed = useRef(props.selection)
  useLayoutEffect(() => {
    latest.current = props
  })
  const capture = useCallback((): SourceViewPosition | undefined => {
    const source = instance.current
    if (!source || !ready.current) return
    const inset = Math.min(
      latest.current.padding.top,
      reviewReaderLayout.contentInset
    )
    const offset = source.getScrollTop() + inset
    const max = source.getModel()?.getLineCount() ?? 1
    let line = source.getVisibleRanges()[0]?.startLineNumber ?? 1
    while (line < max && source.getBottomForLineNumber(line) <= offset) line++
    const top = source.getTopForLineNumber(line)
    const height = Math.max(1, source.getBottomForLineNumber(line) - top)
    return {
      point: {
        side: latest.current.change.after ? "after" : "before",
        line,
        fraction: Math.max(0, Math.min(1, (offset - top) / height)),
      },
      split: false,
      singleCode: source.saveViewState(),
    }
  }, [])
  useImperativeHandle(
    handle,
    () => ({
      capture,
      find: () => {
        void instance.current?.getAction("actions.find")?.run()
      },
    }),
    [capture]
  )
  useEffect(() => {
    const lines = text
      ? text.split("\n").length - Number(text.endsWith("\n"))
      : 0
    onCounts({
      added: side === "after" ? lines : 0,
      removed: side === "before" ? lines : 0,
    })
  }, [text, side, onCounts])
  const reveal = useCallback((restore: boolean) => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      const source = instance.current
      if (!source) return
      source.layout()
      const { point, saved, passage, position, modelScope, change, padding } =
        latest.current
      const inset = Math.min(padding.top, reviewReaderLayout.contentInset)
      marker.current?.clear()
      const start = change.after ? passage?.newStart : passage?.oldStart
      const lines = change.after ? passage?.newLines : passage?.oldLines
      // Only explicit references highlight a passage in a whole-file view.
      if (modelScope === "reference" && passage) {
        marker.current?.set([
          {
            range: {
              startLineNumber: start ?? 1,
              endLineNumber: (start ?? 1) + Math.max(lines ?? 1, 1) - 1,
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
      }
      if (restore && point) {
        if (saved?.singleCode && sameReadingPoint(point, saved.point))
          source.restoreViewState(saved.singleCode)
        else {
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
                inset
            )
          )
        }
      } else if (
        restore &&
        modelScope !== "reference" &&
        position.changeId === change.id &&
        position.line > 0
      ) {
        source.setPosition({ lineNumber: position.line, column: 1 })
        source.setScrollTop(position.scrollTop)
      } else if (modelScope === "reference" && passage) {
        revealPassage(
          source,
          start ?? 1,
          (start ?? 1) + Math.max(lines ?? 1, 1) - 1,
          { top: inset, bottom: padding.bottom }
        )
      }
      ready.current = true
    })
  }, [])
  useEffect(() => {
    if (!instance.current || revealed.current === props.selection) return
    revealed.current = props.selection
    reveal(false)
  }, [props.selection, reveal])
  useLayoutEffect(
    () => () => {
      const position = capture()
      if (position) latest.current.onCapture(position)
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      cleanup.current?.()
      marker.current?.clear()
      instance.current = null
    },
    [capture]
  )
  return (
    <CodeEditor
      height="100%"
      overlayTop={Math.max(0, padding.top - reviewReaderLayout.contentInset)}
      value={text}
      path={`reviewbox://${snapshot.id}/${change.id}/${modelScope}/${side}/${path}`}
      languageDocument={
        file && modelScope !== "local"
          ? {
              snapshotId: snapshot.id,
              path,
              changeId: change.id,
              side,
              contentHash: file.hash,
            }
          : undefined
      }
      language={languageFor(path)}
      theme={reviewboxTheme(resolvedTheme !== "light")}
      options={{
        readOnly: true,
        automaticLayout: true,
        minimap: { enabled: false },
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        lineHeight: 20,
        fontLigatures: false,
        wordWrap: "on",
        wrappingIndent: "same",
        scrollBeyondLastLine: false,
        padding,
        glyphMargin: false,
        folding: false,
        lineDecorationsWidth: 12,
        scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
      }}
      onMount={(source) => {
        instance.current = source
        marker.current = source.createDecorationsCollection()
        reveal(true)
        let timer: ReturnType<typeof setTimeout> | undefined
        const persist = () => {
          const position = capture()
          if (!position) return
          latest.current.onCapture(position)
          clearTimeout(timer)
          timer = setTimeout(
            () =>
              latest.current.onPosition({
                ...latest.current.position,
                changeId: latest.current.change.id,
                passageId: latest.current.passage?.id ?? null,
                line: source.getPosition()?.lineNumber ?? 1,
                scrollTop: source.getScrollTop(),
                split: latest.current.split,
              }),
            500
          )
        }
        const subscriptions = [
          observeSourceSelection(source, side, (selection) =>
            latest.current.onCommentSelection?.(selection)
          ),
          source.onDidScrollChange(persist),
          source.onDidChangeCursorPosition((event) => {
            latest.current.onCursor({
              line: event.position.lineNumber,
              column: event.position.column,
            })
            persist()
          }),
        ]
        cleanup.current = () => {
          clearTimeout(timer)
          subscriptions.forEach((subscription) => subscription.dispose())
        }
      }}
    />
  )
}
