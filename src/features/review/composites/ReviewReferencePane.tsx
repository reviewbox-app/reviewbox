"use client"
import { reviewReaderLayout } from "../reader.config"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTheme } from "next-themes"
import { CodeFileHeader } from "@/features/code-editor/components/CodeFileHeader"
import type { editor } from "monaco-editor"
import type {
  DocumentReference,
  FrozenSource,
  Workspace,
} from "@/lib/desktop/contracts.generated"
import { CodeEditor } from "@/features/code-editor/components/CodeEditor"
import { reviewboxTheme } from "@/lib/monaco/reviewboxThemes"
import { errorMessage } from "@/lib/desktop/review.commands"
import { readerCommands } from "../services/reader.commands"
import { languageFor } from "../helpers/review.helpers"
import { revealPassage } from "../helpers/revealPassage.helpers"
import { ReviewCodePane } from "./ReviewCodePane"

/** Exploring a reference never changes the primary reading or decision cursor. */
export function ReviewReferencePane({
  workspace,
  reference,
  overlay,
}: {
  workspace: Workspace
  reference: DocumentReference
  overlay: { top: number; bottom: number }
}) {
  const match = /^change:(.+):(before|after)$/.exec(reference.sourceId)
  const sourceSide = match?.[2]
  const change = workspace.snapshot.changes.find(
    (item) => item.id === match?.[1]
  )
  const key = `${workspace.snapshot.id}/${reference.sourceId}`
  const requestKey = `${key}/${reference.startLine}/${reference.endLine}`
  const [loaded, setLoaded] = useState<{
    key: string
    source?: FrozenSource
    error?: string
  } | null>(null)
  const { resolvedTheme } = useTheme()
  const mounted = useRef<editor.IStandaloneCodeEditor | null>(null)
  const marker = useRef<editor.IEditorDecorationsCollection | null>(null)
  const content = loaded?.key === requestKey ? loaded : null
  const selection = useMemo(
    () => ({
      snapshotId: workspace.snapshot.id,
      changeId: change?.id ?? reference.sourceId,
      passageId: `reference:${reference.id}:${reference.startLine}:${reference.endLine}`,
    }),
    [workspace.snapshot.id, change?.id, reference]
  )
  const passage = useMemo(
    () => ({
      id: selection.passageId,
      oldStart: reference.startLine,
      newStart: reference.startLine,
      oldLines:
        sourceSide === "before"
          ? reference.endLine - reference.startLine + 1
          : 0,
      newLines:
        sourceSide === "before"
          ? 0
          : reference.endLine - reference.startLine + 1,
      fingerprint: "reference",
    }),
    [selection.passageId, reference.startLine, reference.endLine, sourceSide]
  )
  useEffect(() => {
    let alive = true
    void readerCommands
      .source(workspace.snapshot.id, reference.sourceId)
      .then((source) => {
        if (source.text === null)
          throw new Error(
            source.unavailableReason || "This captured source is unavailable."
          )
        if (
          reference.startLine < 1 ||
          reference.endLine < reference.startLine ||
          reference.endLine > source.text.split("\n").length
        )
          throw new Error("This reference is outside the captured source.")
        if (alive) setLoaded({ key: requestKey, source })
      })
      .catch((cause) => {
        if (alive) setLoaded({ key: requestKey, error: errorMessage(cause) })
      })
    return () => {
      alive = false
    }
  }, [
    workspace.snapshot.id,
    reference.sourceId,
    reference.startLine,
    reference.endLine,
    requestKey,
  ])
  const highlight = useCallback(() => {
    if (!mounted.current) return
    marker.current?.set([
      {
        range: {
          startLineNumber: reference.startLine,
          endLineNumber: reference.endLine,
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
    revealPassage(mounted.current, reference.startLine, reference.endLine, {
      top: reviewReaderLayout.contentInset,
      bottom: overlay.bottom + reviewReaderLayout.contentInset,
    })
  }, [reference, overlay.bottom])
  useEffect(() => {
    highlight()
  }, [highlight, content])
  useEffect(
    () => () => {
      marker.current?.clear()
      mounted.current = null
    },
    []
  )
  if (content?.error)
    return (
      <p
        role="status"
        className="px-6 text-sm text-muted-foreground"
        style={{ paddingTop: overlay.top + 24 }}
      >
        {content.error}
      </p>
    )
  if (!content?.source)
    return (
      <p
        role="status"
        className="px-6 text-sm text-muted-foreground"
        style={{ paddingTop: overlay.top + 24 }}
      >
        Loading captured source…
      </p>
    )
  if (change)
    return (
      <ReviewCodePane
        key={key}
        snapshot={workspace.snapshot}
        change={change}
        selection={selection}
        passage={passage}
        position={{
          ...workspace.review.position,
          changeId: null,
          line: 0,
          scrollTop: 0,
        }}
        onPosition={() => {}}
        overlay={overlay}
        modelScope="reference"
      />
    )
  const source = content.source
  return (
    <section className="absolute inset-0" aria-label="Referenced source">
      <CodeFileHeader
        path={source.path}
        className="absolute inset-x-0 z-10 glass-bar"
        style={{ top: overlay.top }}
      />
      <CodeEditor
        key={key}
        height="100%"
        overlayTop={overlay.top + reviewReaderLayout.codeHeaderHeight}
        path={`reviewbox://reference/${key}`}
        value={source.text ?? ""}
        languageDocument={{
          snapshotId: workspace.snapshot.id,
          path: source.path,
          changeId: null,
          side: null,
          contentHash: source.hash,
        }}
        language={languageFor(source.path)}
        theme={reviewboxTheme(resolvedTheme !== "light")}
        options={{
          readOnly: true,
          automaticLayout: true,
          minimap: { enabled: false },
          fontLigatures: false,
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          lineHeight: 20,
          padding: {
            top:
              overlay.top +
              reviewReaderLayout.codeHeaderHeight +
              reviewReaderLayout.contentInset,
            bottom: overlay.bottom + reviewReaderLayout.contentInset,
          },
          wordWrap: "on",
          wrappingIndent: "same",
          scrollBeyondLastLine: false,
        }}
        onMount={(instance) => {
          mounted.current = instance
          marker.current = instance.createDecorationsCollection()
          // Automatic layout runs asynchronously; measure the mounted viewport
          // before calculating its center on the first navigation.
          instance.layout()
          highlight()
        }}
      />
    </section>
  )
}
