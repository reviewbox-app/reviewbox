"use client"
import { useEffect, useLayoutEffect, useState, useRef } from "react"
import { useTheme } from "next-themes"
import { CodeEditor } from "@/features/code-editor/components/CodeEditor"
import {
  CodeFileHeader,
  codeFileHeaderHeight,
} from "@/features/code-editor/components/CodeFileHeader"
import { editorCommands } from "@/features/code-editor/services/editor.commands"
import { subscribeRepositoryReads } from "@/lib/desktop/repositoryReads"
import type { EditorFile } from "@/lib/desktop/contracts.generated"
import { errorMessage } from "@/lib/desktop/review.commands"
import { reviewboxTheme } from "@/lib/monaco/reviewboxThemes"
import { languageFor } from "@/features/review/helpers/review.helpers"
import { reviewReaderLayout } from "@/features/review/reader.config"

import { observeSourceSelection } from "@/features/code-editor/services/sourceSelection"
import type {
  SourceSearchTarget,
  SourceSelection,
} from "@/features/code-editor/contracts/sourceSelection.types"

/** Live unchanged files are inspected without creating a review or an editable buffer. */
export function LocalSourceFile({
  repositoryId,
  path,
  onSelection,
  searchTarget,
}: {
  searchTarget?: SourceSearchTarget
  repositoryId: string
  path: string
  onSelection: (file: EditorFile, selection: SourceSelection | null) => void
}) {
  const instance = useRef<
    import("monaco-editor").editor.IStandaloneCodeEditor | null
  >(null)
  const reveal = () => {
    const editor = instance.current
    if (!editor || !searchTarget) return
    const range = editor.getModel()?.validateRange({
      startLineNumber: searchTarget.line,
      endLineNumber: searchTarget.line,
      startColumn: searchTarget.column,
      endColumn: searchTarget.column + searchTarget.length,
    })
    if (range) {
      editor.setSelection(range)
      editor.revealRangeInCenter(range)
    }
  }
  const current = useRef({ file: null as EditorFile | null, onSelection })
  const observer = useRef<{ dispose: () => void } | null>(null)
  useEffect(() => () => observer.current?.dispose(), [])
  const { resolvedTheme } = useTheme()
  const [file, setFile] = useState<EditorFile | null>(null)
  const [error, setError] = useState("")
  useEffect(reveal, [searchTarget, file?.text])
  useLayoutEffect(() => {
    current.current = { file, onSelection }
  }, [file, onSelection])
  useEffect(() => {
    let active = true
    let token = 0
    const read = async () => {
      const request = ++token
      try {
        const file = await editorCommands.read(repositoryId, path)
        if (active && request === token) {
          setFile(file)
          setError("")
        }
      } catch (error) {
        if (active && request === token) setError(errorMessage(error))
      }
    }
    void read()
    const stop = subscribeRepositoryReads(
      repositoryId,
      (change) => {
        if (change.full || change.paths.includes(path)) void read()
      },
      () => void read()
    )
    return () => {
      active = false
      stop()
    }
  }, [repositoryId, path])
  return (
    <section className="absolute inset-0" aria-label="Unchanged source">
      <CodeFileHeader
        path={path}
        className="absolute inset-x-0 z-10 glass-bar"
        style={{ top: reviewReaderLayout.headerHeight }}
      >
        <span
          className="shrink-0 text-muted-foreground"
          title={file?.reason ?? "Live source inspection"}
        >
          Read only
        </span>
      </CodeFileHeader>
      {error || (file?.reason && !file.text) ? (
        <p
          role="status"
          className="px-4"
          style={{
            paddingTop:
              reviewReaderLayout.headerHeight + codeFileHeaderHeight + 16,
          }}
        >
          {error || file?.reason}
        </p>
      ) : (
        <CodeEditor
          inspectionDocument={{ repositoryId, path }}
          onMount={(editor) => {
            instance.current = editor
            reveal()
            observer.current?.dispose()
            observer.current = observeSourceSelection(
              editor,
              "after",
              (selection) => {
                const { file, onSelection } = current.current
                if (file) onSelection(file, selection)
              }
            )
          }}
          height="100%"
          path={`reviewbox-local://${repositoryId}/${path}`}
          value={file?.text ?? ""}
          sourcePath={path}
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
            wordWrap: "on",
            padding: {
              top: reviewReaderLayout.headerHeight + codeFileHeaderHeight + 8,
              bottom: reviewReaderLayout.footerHeight + 8,
            },
          }}
        />
      )}
    </section>
  )
}
