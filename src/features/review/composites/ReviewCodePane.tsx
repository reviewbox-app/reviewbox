"use client"
import { useEffect, useRef, useState } from "react"
import { useTheme } from "next-themes"
import type { editor } from "monaco-editor"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  FileEditIcon,
  MoreHorizontalIcon,
  Search01Icon,
  Target02Icon,
  ViewIcon,
} from "@hugeicons/core-free-icons"
import { CodeDiffEditor } from "@/features/code-editor/components/CodeDiffEditor"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { reviewboxTheme } from "@/lib/monaco/reviewboxThemes"
import type {
  Change,
  Passage,
  Snapshot,
  FileContent,
  ReadingPosition,
} from "@/lib/desktop/contracts.generated"
import { errorMessage, reviewCommands } from "@/lib/desktop/review.commands"
import {
  fileName,
  folderOf,
  languageFor,
  languageName,
} from "../helpers/review.helpers"
import { useReviewWorkspaceStore } from "../stores/useReviewWorkspace.store"

function passageDecoration(passage: Passage): editor.IModelDeltaDecoration {
  const start = passage.newLines ? passage.newStart : passage.oldStart
  return {
    range: {
      startLineNumber: start,
      endLineNumber:
        start + Math.max(passage.newLines || passage.oldLines, 1) - 1,
      startColumn: 1,
      endColumn: 1,
    },
    options: {
      isWholeLine: true,
      className: "review-passage",
      marginClassName: "review-passage-margin",
    },
  }
}

export function ReviewCodePane({
  snapshot,
  change,
  passage,
  stepLabel,
  position,
  onPosition,
}: {
  snapshot: Snapshot
  change: Change
  passage?: Passage
  /** "Step 2 · lines 18–34" when the passage belongs to the reading path. */
  stepLabel?: string
  position: ReadingPosition
  onPosition: (position: ReadingPosition) => void
}) {
  const [trimWhitespace, setTrimWhitespace] = useState(false)
  const [content, setContent] = useState<FileContent | null>(null)
  const [error, setError] = useState("")
  const [counts, setCounts] = useState<{
    added: number
    removed: number
  } | null>(null)
  const [cursor, setCursor] = useState<{ line: number; column: number } | null>(
    null
  )
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
    side?.set([passageDecoration(passage)])
    const target = passage.newLines
      ? instance.current.getModifiedEditor()
      : instance.current.getOriginalEditor()
    target.revealLineInCenter(
      passage.newLines ? passage.newStart : passage.oldStart
    )
  }, [passage])
  const folder = folderOf(change.path)
  return (
    <section
      className="relative flex min-w-0 flex-1 flex-col overflow-hidden"
      aria-label="Code diff"
    >
      <header className="flex h-12 shrink-0 items-center gap-3 border-b pr-3 pl-4">
        <HugeiconsIcon
          icon={FileEditIcon}
          size={16}
          className="shrink-0 text-muted-foreground"
        />
        <span
          className="min-w-0 truncate text-sm"
          title={
            change.previousPath
              ? `${change.previousPath} → ${change.path}`
              : change.path
          }
        >
          {folder && <span className="text-muted-foreground">{folder}/</span>}
          <span className="font-medium">{fileName(change.path)}</span>
        </span>
        {counts && (
          <span className="flex shrink-0 gap-1.5 text-xs font-medium tabular-nums">
            {counts.added > 0 && (
              <span className="text-diff-added">+{counts.added}</span>
            )}
            {counts.removed > 0 && (
              <span className="text-diff-removed">−{counts.removed}</span>
            )}
          </span>
        )}
        {change.previousPath && (
          <Badge
            variant="secondary"
            title={`Moved from ${change.previousPath}`}
          >
            Moved
          </Badge>
        )}
        {stepLabel && (
          <Badge variant="secondary" className="shrink-0">
            <HugeiconsIcon icon={Target02Icon} />
            {stepLabel}
          </Badge>
        )}
        <span className="flex-1" />
        <Tabs
          value={split ? "split" : "unified"}
          onValueChange={(value) => setSplit(value === "split")}
        >
          <TabsList>
            <TabsTrigger value="unified">Unified</TabsTrigger>
            <TabsTrigger value="split">Split</TabsTrigger>
          </TabsList>
        </Tabs>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Find in file"
          disabled={!content}
          onClick={() =>
            void instance.current
              ?.getModifiedEditor()
              .getAction("actions.find")
              ?.run()
          }
        >
          <HugeiconsIcon icon={Search01Icon} size={16} />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Display options"
              />
            }
          >
            <HugeiconsIcon icon={MoreHorizontalIcon} size={16} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Display · {change.layer}</DropdownMenuLabel>
              <DropdownMenuCheckboxItem
                checked={trimWhitespace}
                onCheckedChange={setTrimWhitespace}
              >
                Hide edge whitespace
              </DropdownMenuCheckboxItem>
            </DropdownMenuGroup>
            <p className="px-2 pt-1 pb-2 text-xs text-muted-foreground">
              Filtering changes the display only. Coverage still counts the raw
              diff.
            </p>
          </DropdownMenuContent>
        </DropdownMenu>
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
              scrollBeyondLastLine: false,
              padding: { top: 8, bottom: 8 },
              hideUnchangedRegions: { enabled: true, contextLineCount: 4 },
              renderOverviewRuler: false,
              renderIndicators: true,
              glyphMargin: false,
              folding: false,
              lineDecorationsWidth: 12,
              scrollbar: {
                verticalScrollbarSize: 8,
                horizontalScrollbarSize: 8,
              },
            }}
            onMount={(mounted) => {
              instance.current = mounted
              const modified = mounted.getModifiedEditor()
              const original = mounted.getOriginalEditor()
              const beforeMarks = original.createDecorationsCollection()
              const afterMarks = modified.createDecorationsCollection()
              marks.current = { before: beforeMarks, after: afterMarks }
              if (passage)
                (passage.newLines ? afterMarks : beforeMarks).set([
                  passageDecoration(passage),
                ])
              if (position.changeId === change.id && position.line > 0) {
                modified.setPosition({ lineNumber: position.line, column: 1 })
                modified.setScrollTop(position.scrollTop)
              } else if (passage) {
                ;(passage.newLines ? modified : original).revealLineInCenter(
                  passage.newLines ? passage.newStart : passage.oldStart
                )
              }
              const diff = mounted.onDidUpdateDiff(() => {
                let added = 0
                let removed = 0
                for (const c of mounted.getLineChanges() ?? []) {
                  if (c.modifiedEndLineNumber > 0)
                    added +=
                      c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1
                  if (c.originalEndLineNumber > 0)
                    removed +=
                      c.originalEndLineNumber - c.originalStartLineNumber + 1
                }
                setCounts({ added, removed })
              })
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
              const moved = modified.onDidChangeCursorPosition((event) => {
                setCursor({
                  line: event.position.lineNumber,
                  column: event.position.column,
                })
                persist()
              })
              cleanup.current = () => {
                clearTimeout(timer)
                diff.dispose()
                scroll.dispose()
                moved.dispose()
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
      <footer className="flex h-7 shrink-0 items-center gap-4 border-t px-4 text-xs text-muted-foreground">
        <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate">
          <HugeiconsIcon icon={ViewIcon} size={14} />
          Read-only · snapshot {snapshot.id.slice(0, 6)}
          {trimWhitespace ? " · filtered display, raw coverage" : ""}
        </span>
        <span>{languageName(change.path)}</span>
        <span>UTF-8</span>
        {cursor && (
          <span className="tabular-nums">
            Ln {cursor.line}, Col {cursor.column}
          </span>
        )}
      </footer>
    </section>
  )
}
