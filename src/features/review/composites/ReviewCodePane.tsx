"use client"

import { FileIcon } from "@/features/file-icons/components/FileIcon"
import { useEffect, useRef, useState } from "react"
import { useTheme } from "next-themes"
import type { editor } from "monaco-editor"
import { HugeiconsIcon } from "@hugeicons/react"
import {
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
import { cn } from "@/lib/utils"
import type {
  Change,
  Passage,
  Snapshot,
  FileContent,
  ReadingPosition,
  CodeAnchor,
} from "@/lib/desktop/contracts.generated"
import { errorMessage, reviewCommands } from "@/lib/desktop/review.commands"
import {
  fileName,
  folderOf,
  languageFor,
  languageName,
} from "../helpers/review.helpers"
import {
  registerPseudocode,
  type PseudoContent,
} from "../helpers/pseudocode.helpers"
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
  selection,
  stepLabel,
  position,
  onPosition,
  overlay,
  representation = "real",
  modelScope = "reader",
  pseudo,
}: {
  representation?: "real" | "pseudo"
  /** Each simultaneous diff owns distinct Monaco models and their lifecycle. */
  modelScope?: "reader" | "reference"
  pseudo?: PseudoContent
  snapshot: Snapshot
  change: Change
  passage?: Passage
  /** Changes only for deliberate navigation, not saved/reloaded review data. */
  selection: CodeAnchor | null
  /** "Step 2 · lines 18–34" when the passage belongs to the reading path. */
  stepLabel?: string
  position: ReadingPosition
  onPosition: (position: ReadingPosition) => void
  /**
   * Space taken by floating bars of the parent (px). The file header and status
   * bar float too, and the code scrolls underneath all of them.
   */
  overlay?: { top: number; bottom: number }
}) {
  const [trimWhitespace, setTrimWhitespace] = useState(false)
  const [rawContent, setContent] = useState<FileContent | null>(null)
  const content =
    representation === "pseudo"
      ? (pseudo ?? {
          before: null,
          after: null,
          unavailableReason: "Loading pseudocode…",
        })
      : rawContent
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
  const selectedRef = useRef({ passage, split, selection })
  const revealedSelection = useRef<CodeAnchor | null>(null)
  const marks = useRef<{
    before: editor.IEditorDecorationsCollection
    after: editor.IEditorDecorationsCollection
  } | null>(null)
  const save = useRef(onPosition)
  const positionRef = useRef(position)
  useEffect(() => {
    save.current = onPosition
    positionRef.current = position
    selectedRef.current = { passage, split, selection }
  }, [onPosition, position, passage, split, selection])
  useEffect(() => {
    let alive = true
    if (representation === "pseudo") return
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
    }
  }, [snapshot.id, change.id, representation])
  useEffect(
    () => () => {
      cleanup.current?.()
      cleanup.current = null
      instance.current = null
    },
    []
  )
  useEffect(() => {
    // Saving scroll position returns fresh passage objects. That is not navigation.
    if (!instance.current || revealedSelection.current === selection) return
    revealedSelection.current = selection
    marks.current?.before.clear()
    marks.current?.after.clear()
    if (!passage) return
    const side = passage.newLines ? marks.current?.after : marks.current?.before
    side?.set([passageDecoration(passage)])
    const target = passage.newLines
      ? instance.current.getModifiedEditor()
      : instance.current.getOriginalEditor()
    target.revealLineInCenter(
      passage.newLines ? passage.newStart : passage.oldStart
    )
  }, [passage, selection])
  const folder = folderOf(change.path)
  const HEADER = 48
  const STATUS = 28
  const padding = overlay
    ? { top: overlay.top + HEADER + 8, bottom: overlay.bottom + STATUS + 8 }
    : { top: 8, bottom: 8 }
  return (
    <section
      className={cn(
        "flex min-w-0 flex-col overflow-hidden",
        overlay ? "absolute inset-0" : "relative flex-1"
      )}
      aria-label="Code diff"
    >
      <header
        className={cn(
          "flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2",
          overlay &&
            "absolute inset-x-0 z-10 h-12 flex-nowrap overflow-hidden glass-bar"
        )}
        style={overlay ? { top: overlay.top } : undefined}
      >
        <FileIcon path={change.path} />
        <span
          className="min-w-0 flex-1 basis-20 truncate text-sm"
          title={
            change.previousPath
              ? `${change.previousPath} → ${change.path}`
              : change.path
          }
        >
          {folder && <span className="text-muted-foreground">{folder}/</span>}
          <span className="font-medium">{fileName(change.path)}</span>
        </span>
        {representation === "pseudo" && (
          <Badge variant="secondary" className="max-[1100px]:hidden">
            Pseudocode
          </Badge>
        )}
        {counts && (
          <span className="flex shrink-0 gap-1.5 text-xs font-medium tabular-nums max-[1100px]:hidden">
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
          <Badge variant="secondary" className="shrink-0 max-[1100px]:hidden">
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
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      {representation === "pseudo" && pseudo?.skipReason ? (
        <div
          className="p-8 text-sm leading-6 text-muted-foreground"
          style={overlay ? { paddingTop: padding.top + 24 } : undefined}
        >
          <p className="font-medium text-foreground">
            No pseudo-code for this file
          </p>
          <p className="mt-2">{pseudo.skipReason}</p>
          <p className="mt-2">
            Rev explains the relevant changes in the reading steps.
          </p>
        </div>
      ) : error || content?.unavailableReason ? (
        <div
          className="p-8 text-sm leading-6 text-muted-foreground"
          style={overlay ? { paddingTop: padding.top + 24 } : undefined}
        >
          <p>{error || content?.unavailableReason}</p>
          <dl className="mt-4 space-y-2 font-mono text-xs break-all">
            <dt>Before</dt>
            <dd>{change.before?.hash ?? "Absent"}</dd>
            <dt>After</dt>
            <dd>{change.after?.hash ?? "Absent"}</dd>
          </dl>
        </div>
      ) : content ? (
        <div className={overlay ? "absolute inset-0" : "min-h-0 flex-1"}>
          <CodeDiffEditor
            height="100%"
            beforeMount={registerPseudocode}
            original={content.before ?? ""}
            modified={content.after ?? ""}
            originalLanguageDocument={
              representation === "real" && change.before
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
              representation === "real" && change.after
                ? {
                    snapshotId: snapshot.id,
                    path: change.path,
                    changeId: change.id,
                    side: "after",
                    contentHash: change.after.hash,
                  }
                : undefined
            }
            language={
              representation === "pseudo"
                ? "reviewbox-pseudocode"
                : languageFor(change.path)
            }
            originalModelPath={`reviewbox://${snapshot.id}/${change.id}/${representation}/${modelScope}/before/${change.path}`}
            modifiedModelPath={`reviewbox://${snapshot.id}/${change.id}/${representation}/${modelScope}/after/${change.path}`}
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
              hideUnchangedRegions: {
                enabled: representation === "real",
                contextLineCount: 4,
              },
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
              const { passage, selection } = selectedRef.current
              const position = positionRef.current
              revealedSelection.current = selection
              const modified = mounted.getModifiedEditor()
              const original = mounted.getOriginalEditor()
              const beforeMarks = original.createDecorationsCollection()
              const afterMarks = modified.createDecorationsCollection()
              marks.current = { before: beforeMarks, after: afterMarks }
              if (passage)
                (passage.newLines ? afterMarks : beforeMarks).set([
                  passageDecoration(passage),
                ])
              if (
                position.changeId === change.id &&
                (!passage || position.passageId === passage.id) &&
                position.line > 0
              ) {
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
        <div
          role="status"
          className="p-8 text-sm text-muted-foreground"
          style={overlay ? { paddingTop: padding.top + 24 } : undefined}
        >
          Loading frozen content…
        </div>
      )}
      <footer
        className={cn(
          "flex h-7 shrink-0 items-center gap-4 border-t px-4 text-xs text-muted-foreground",
          overlay && "absolute inset-x-0 z-10 glass-bar"
        )}
        style={overlay ? { bottom: overlay.bottom } : undefined}
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate">
          <HugeiconsIcon icon={ViewIcon} size={14} />
          Read-only · review files {snapshot.id.slice(0, 6)}
          {trimWhitespace ? " · filtered display" : ""}
        </span>
        <span>
          {representation === "pseudo"
            ? "Pseudocode"
            : languageName(change.path)}
        </span>
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
