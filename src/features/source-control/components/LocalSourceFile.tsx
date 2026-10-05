"use client"
import { useEffect, useState } from "react"
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

/** Live unchanged files are inspected without creating a review or an editable buffer. */
export function LocalSourceFile({
  repositoryId,
  path,
}: {
  repositoryId: string
  path: string
}) {
  const { resolvedTheme } = useTheme()
  const [file, setFile] = useState<EditorFile | null>(null)
  const [error, setError] = useState("")
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
          height="100%"
          path={`reviewbox-local://${repositoryId}/${path}`}
          value={file?.text ?? ""}
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
