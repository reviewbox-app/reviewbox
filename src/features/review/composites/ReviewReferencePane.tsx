"use client"
import { useEffect, useMemo, useRef, useState } from "react"
import { useTheme } from "next-themes"
import { FileIcon } from "@/features/file-icons/components/FileIcon"
import type { editor } from "monaco-editor"
import type {
  DocumentReference,
  ReadingLevel,
  ReviewFileContent,
  Workspace,
} from "@/lib/desktop/contracts.generated"
import { CodeEditor } from "@/features/code-editor/components/CodeEditor"
import { reviewboxTheme } from "@/lib/monaco/reviewboxThemes"
import { errorMessage } from "@/lib/desktop/review.commands"
import { readerCommands } from "../services/reader.commands"
import { languageFor } from "../helpers/review.helpers"
import {
  pseudoDiff,
  pseudoPassage,
  registerPseudocode,
} from "../helpers/pseudocode.helpers"
import { ReviewCodePane } from "./ReviewCodePane"

/** Exploring a reference never changes the primary reading or decision cursor. */
export function ReviewReferencePane({
  workspace,
  reference,
  level,
  representation,
  overlay,
}: {
  workspace: Workspace
  reference: DocumentReference
  level: ReadingLevel
  representation: "real" | "pseudo"
  overlay: { top: number; bottom: number }
}) {
  const match = /^change:(.+):(before|after)$/.exec(reference.sourceId)
  const sourceSide = match?.[2]
  const change = workspace.snapshot.changes.find(
    (item) => item.id === match?.[1]
  )
  const isChange = !!change
  const sourceHash = reference.sourceId.startsWith("file:")
    ? workspace.snapshot.files.find(
        (item) => item.path === reference.sourceId.slice(5)
      )?.content.hash
    : sourceSide === "before"
      ? change?.before?.hash
      : change?.after?.hash
  const file =
    workspace.review.files.find((item) =>
      item.translations.some(
        (translation) => translation.sourceId === reference.sourceId
      )
    ) ??
    workspace.review.files.find(
      (item) => reference.sourceId === `file:${item.path}`
    ) ??
    workspace.review.files.find((item) =>
      item.translations.some(
        (translation) =>
          translation.sourceHash === sourceHash && translation.available
      )
    )
  const pseudo = level === "intermediate" || representation === "pseudo"
  const key = `${workspace.review.id}/${workspace.snapshot.id}/${reference.sourceId}/${pseudo}`
  const [loaded, setLoaded] = useState<{
    key: string
    file?: ReviewFileContent
    text?: string
    error?: string
    path?: string
  } | null>(null)
  const fileId = file?.id
  const { resolvedTheme } = useTheme()
  const mounted = useRef<editor.IStandaloneCodeEditor | null>(null)
  const marker = useRef<editor.IEditorDecorationsCollection | null>(null)
  const content = loaded?.key === key ? loaded : null
  const selection = useMemo(
    () => ({
      snapshotId: workspace.snapshot.id,
      changeId: change?.id ?? reference.sourceId,
      passageId: `reference:${reference.id}:${reference.startLine}:${reference.endLine}`,
    }),
    [
      workspace.snapshot.id,
      change?.id,
      reference.sourceId,
      reference.id,
      reference.startLine,
      reference.endLine,
    ]
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
    const load = async () => {
      if (pseudo) {
        if (!fileId)
          throw new Error("Pseudocode is unavailable for this reference.")
        const payload = await readerCommands.file(workspace.review.id, fileId)
        if (
          payload.pseudocodeSelected === false ||
          payload.pseudocodeSkipReason
        )
          throw new Error("No pseudo-code for this passage")
        const translation =
          payload.translations.find(
            (item) => item.sourceId === reference.sourceId
          ) ??
          payload.translations.find(
            (item) => item.sourceHash === sourceHash && !item.unavailableReason
          )
        if (!translation || translation.unavailableReason)
          throw new Error(
            translation?.unavailableReason ||
              "Pseudocode is unavailable for this reference."
          )
        if (
          !translation.blocks.some(
            (block) =>
              block.endLine >= reference.startLine &&
              block.startLine <= reference.endLine
          )
        )
          throw new Error("No pseudo-code for this passage")
        return {
          key,
          file: payload,
          text: translation.blocks.map((block) => block.text).join("\n"),
          path: reference.sourceId.slice(5),
        }
      }
      if (isChange) return { key }
      const source = await readerCommands.source(
        workspace.snapshot.id,
        reference.sourceId
      )
      if (source.text === null)
        throw new Error(
          source.unavailableReason || "This captured source is unavailable."
        )
      return { key, text: source.text, path: source.path }
    }
    void load()
      .then((result) => {
        if (alive) setLoaded(result)
      })
      .catch((cause) => {
        if (alive) setLoaded({ key, error: errorMessage(cause) })
      })
    return () => {
      alive = false
    }
  }, [
    workspace.review.id,
    workspace.snapshot.id,
    reference.sourceId,
    reference.startLine,
    reference.endLine,
    pseudo,
    fileId,
    sourceHash,
    key,
    isChange,
  ])
  const translated =
    content?.file?.translations.find(
      (item) => item.sourceId === reference.sourceId
    ) ??
    content?.file?.translations.find(
      (item) => item.sourceHash === sourceHash && !item.unavailableReason
    )
  let start = reference.startLine
  let end = reference.endLine
  if (pseudo && translated) {
    let cursor = 1
    start = 0
    end = 0
    for (const block of translated.blocks) {
      const lines = block.text.split("\n").length
      if (
        block.endLine >= reference.startLine &&
        block.startLine <= reference.endLine
      ) {
        if (!start) start = cursor
        end = cursor + lines - 1
      }
      cursor += lines
    }
  }
  useEffect(() => {
    if (!mounted.current) return
    if (!start) {
      marker.current?.clear()
      return
    }
    marker.current?.set([
      {
        range: {
          startLineNumber: start,
          endLineNumber: end,
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
    mounted.current.revealLineInCenter(start)
  }, [start, end, key])
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
  if (change)
    return (
      <ReviewCodePane
        key={`${key}/${reference.id}`}
        snapshot={workspace.snapshot}
        change={change}
        selection={selection}
        passage={
          pseudo
            ? pseudoPassage(change, passage, content?.file ?? null)
            : passage
        }
        position={{
          ...workspace.review.position,
          changeId: null,
          line: 0,
          scrollTop: 0,
        }}
        onPosition={() => {}}
        overlay={overlay}
        modelScope="reference"
        representation={pseudo ? "pseudo" : "real"}
        pseudo={pseudoDiff(change, content?.file ?? null)}
      />
    )
  if (!content)
    return (
      <p
        role="status"
        className="px-6 text-sm text-muted-foreground"
        style={{ paddingTop: overlay.top + 24 }}
      >
        Loading captured source…
      </p>
    )
  return (
    <section className="absolute inset-0" aria-label="Referenced source">
      <header
        className="absolute inset-x-0 z-10 flex h-12 items-center gap-2 truncate border-b glass-bar px-4 text-xs"
        style={{ top: overlay.top }}
      >
        <FileIcon path={content.path ?? ""} />
        {content.path}
      </header>
      <CodeEditor
        key={key}
        height="100%"
        path={`reviewbox://reference/${key}`}
        value={content.text ?? ""}
        languageDocument={
          !pseudo && sourceHash && content.path
            ? {
                snapshotId: workspace.snapshot.id,
                path: content.path,
                changeId: null,
                side: null,
                contentHash: sourceHash,
              }
            : undefined
        }
        language={
          pseudo ? "reviewbox-pseudocode" : languageFor(content.path ?? "")
        }
        beforeMount={registerPseudocode}
        theme={reviewboxTheme(resolvedTheme !== "light")}
        options={{
          readOnly: true,
          automaticLayout: true,
          minimap: { enabled: false },
          fontLigatures: false,
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          lineHeight: 20,
          padding: { top: overlay.top + 56, bottom: overlay.bottom + 8 },
          wordWrap: "on",
          wrappingIndent: "same",
          scrollBeyondLastLine: false,
        }}
        onMount={(instance) => {
          mounted.current = instance
          marker.current = instance.createDecorationsCollection([
            {
              range: {
                startLineNumber: Math.max(1, start),
                endLineNumber: Math.max(1, end),
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
          instance.revealLineInCenter(Math.max(1, start))
        }}
      />
    </section>
  )
}
