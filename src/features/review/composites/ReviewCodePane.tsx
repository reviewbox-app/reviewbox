"use client"
import { useEffect, useRef, useState } from "react"
import { useTheme } from "next-themes"
import type { editor } from "monaco-editor"
import { CodeDiffEditor } from "@/features/code-editor/components/CodeDiffEditor"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import type {
  Change,
  Passage,
  Snapshot,
  FileContent,
  ReadingPosition,
} from "@/lib/desktop/contracts.generated"
import { errorMessage, reviewCommands } from "@/lib/desktop/review.commands"
import { languageFor } from "../helpers/review.helpers"
import { useReviewWorkspaceStore } from "../stores/useReviewWorkspace.store"

export function ReviewCodePane({
  snapshot,
  change,
  passage,
  position,
  onPosition,
}: {
  snapshot: Snapshot
  change: Change
  passage?: Passage
  position: ReadingPosition
  onPosition: (position: ReadingPosition) => void
}) {
  const [trimWhitespace, setTrimWhitespace] = useState(false)
  const [content, setContent] = useState<FileContent | null>(null)
  const [error, setError] = useState("")
  const { resolvedTheme } = useTheme()
  const { split, setSplit } = useReviewWorkspaceStore()
  const instance = useRef<editor.IStandaloneDiffEditor | null>(null)
  const cleanup = useRef<(() => void) | null>(null)
  const selectedRef = useRef({ passage, split })
  const marks = useRef<{
    before: editor.IEditorDecorationsCollection
    after: editor.IEditorDecorationsCollection
  } | null>(null)
  const save = useRef(onPosition)
  const positionRef = useRef(position)
  useEffect(() => {
    save.current = onPosition
    positionRef.current = position
    selectedRef.current = { passage, split }
  }, [onPosition, position, passage, split])
  useEffect(() => {
    let alive = true
    reviewCommands
      .content(snapshot.id, change.id)
      .then((v) => {
        if (alive) setContent(v)
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e))
      })
    return () => {
      alive = false
      cleanup.current?.()
      cleanup.current = null
      instance.current = null
    }
  }, [snapshot.id, change.id])
  useEffect(() => {
    if (!passage || !instance.current) return
    marks.current?.before.clear()
    marks.current?.after.clear()
    const side = passage.newLines ? marks.current?.after : marks.current?.before
    const start = passage.newLines ? passage.newStart : passage.oldStart
    side?.set([
      {
        range: {
          startLineNumber: start,
          endLineNumber:
            start + Math.max(passage.newLines || passage.oldLines, 1) - 1,
          startColumn: 1,
          endColumn: 1,
        },
        options: { isWholeLine: true, className: "review-passage" },
      },
    ])
    const target = passage.newLines
      ? instance.current.getModifiedEditor()
      : instance.current.getOriginalEditor()
    target.revealLineInCenter(
      passage.newLines ? passage.newStart : passage.oldStart
    )
  }, [passage])
  return (
    <section
      className="flex min-w-0 flex-1 flex-col overflow-hidden"
      aria-label="Code diff"
    >
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
        <span
          className="min-w-0 flex-1 truncate font-mono text-xs"
          title={change.path}
        >
          {change.path}
        </span>
        {change.previousPath && (
          <Badge
            variant="outline"
            title={`Exact content moved from ${change.previousPath}`}
          >
            Moved
          </Badge>
        )}
        <Badge variant="secondary">{change.layer}</Badge>
        <Button
          size="xs"
          variant={trimWhitespace ? "secondary" : "ghost"}
          onClick={() => setTrimWhitespace(!trimWhitespace)}
          title="Changes remain in coverage even when whitespace is hidden"
        >
          {trimWhitespace ? "Show raw" : "Hide edge whitespace"}
        </Button>
        <div className="flex rounded-full bg-muted p-0.5">
          <Button
            variant={split ? "ghost" : "secondary"}
            size="xs"
            onClick={() => setSplit(false)}
          >
            Unified
          </Button>
          <Button
            variant={split ? "secondary" : "ghost"}
            size="xs"
            onClick={() => setSplit(true)}
          >
            Split
          </Button>
        </div>
      </header>
      {error || content?.unavailableReason ? (
        <div className="p-8 text-sm leading-6 text-muted-foreground">
          <p>{error || content?.unavailableReason}</p>
          <dl className="mt-4 space-y-2 font-mono text-xs break-all">
            <dt>Before</dt>
            <dd>{change.before?.hash ?? "Absent"}</dd>
            <dt>After</dt>
            <dd>{change.after?.hash ?? "Absent"}</dd>
          </dl>
        </div>
      ) : content ? (
        <div className="min-h-0 flex-1">
          <CodeDiffEditor
            height="100%"
            original={content.before ?? ""}
            modified={content.after ?? ""}
            language={languageFor(change.path)}
            originalModelPath={`reviewbox://${snapshot.id}/${change.id}/before/${change.path}`}
            modifiedModelPath={`reviewbox://${snapshot.id}/${change.id}/after/${change.path}`}
            theme={
              resolvedTheme === "dark" ? "reviewbox-dark" : "reviewbox-light"
            }
            beforeMount={(monaco) => {
              for (const dark of [false, true])
                monaco.editor.defineTheme(
                  `reviewbox-${dark ? "dark" : "light"}`,
                  {
                    base: dark ? "vs-dark" : "vs",
                    inherit: true,
                    rules: [
                      {
                        token: "keyword",
                        foreground: dark ? "8fb0ff" : "1447e6",
                      },
                      {
                        token: "string",
                        foreground: dark ? "6ee7b7" : "0b7a55",
                      },
                      {
                        token: "comment",
                        foreground: dark ? "777777" : "999999",
                      },
                      {
                        token: "number",
                        foreground: dark ? "fdba74" : "c2410c",
                      },
                    ],
                    colors: {
                      "editor.background": dark ? "#222222" : "#ffffff",
                      "diffEditor.insertedTextBackground": dark
                        ? "#4ade8020"
                        : "#16a34a20",
                      "diffEditor.removedTextBackground": dark
                        ? "#ff646720"
                        : "#e7000b20",
                      "editorLineNumber.foreground": dark
                        ? "#777777"
                        : "#999999",
                    },
                  }
                )
            }}
            options={{
              readOnly: true,
              ignoreTrimWhitespace: trimWhitespace,
              originalEditable: false,
              renderSideBySide: split,
              automaticLayout: true,
              minimap: { enabled: false },
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              lineHeight: 20,
              fontLigatures: false,
              scrollBeyondLastLine: false,
              padding: { top: 16 },
              hideUnchangedRegions: { enabled: true, contextLineCount: 4 },
              renderOverviewRuler: false,
            }}
            onMount={(mounted) => {
              instance.current = mounted
              const modified = mounted.getModifiedEditor()
              const original = mounted.getOriginalEditor()
              const beforeMarks = original.createDecorationsCollection()
              const afterMarks = modified.createDecorationsCollection()
              marks.current = { before: beforeMarks, after: afterMarks }
              if (passage) {
                const start = passage.newLines
                  ? passage.newStart
                  : passage.oldStart
                const target = passage.newLines ? afterMarks : beforeMarks
                target.set([
                  {
                    range: {
                      startLineNumber: start,
                      endLineNumber:
                        start +
                        Math.max(passage.newLines || passage.oldLines, 1) -
                        1,
                      startColumn: 1,
                      endColumn: 1,
                    },
                    options: { isWholeLine: true, className: "review-passage" },
                  },
                ])
              }
              if (position.changeId === change.id && position.line > 0) {
                modified.setPosition({ lineNumber: position.line, column: 1 })
                modified.setScrollTop(position.scrollTop)
              } else if (passage) {
                ;(passage.newLines ? modified : original).revealLineInCenter(
                  passage.newLines ? passage.newStart : passage.oldStart
                )
              }
              let timer: ReturnType<typeof setTimeout> | undefined
              const persist = () => {
                clearTimeout(timer)
                timer = setTimeout(
                  () =>
                    save.current({
                      ...positionRef.current,
                      changeId: change.id,
                      passageId: selectedRef.current.passage?.id ?? null,
                      line: modified.getPosition()?.lineNumber ?? 1,
                      scrollTop: modified.getScrollTop(),
                      split: selectedRef.current.split,
                    }),
                  500
                )
              }
              const scroll = modified.onDidScrollChange(persist)
              const cursor = modified.onDidChangeCursorPosition(persist)
              cleanup.current = () => {
                clearTimeout(timer)
                scroll.dispose()
                cursor.dispose()
                beforeMarks.clear()
                afterMarks.clear()
                marks.current = null
              }
            }}
          />
        </div>
      ) : (
        <div role="status" className="p-8 text-sm text-muted-foreground">
          Loading frozen content…
        </div>
      )}
      <footer className="flex h-7 shrink-0 items-center justify-between border-t px-4 text-[10px] text-muted-foreground">
        <span>
          Read-only · snapshot {snapshot.id.slice(0, 6)}
          {trimWhitespace ? " · filtered display, raw coverage" : ""}
        </span>
        <span>{languageFor(change.path)} · UTF-8</span>
      </footer>
    </section>
  )
}
