"use client"
import { reviewReaderLayout } from "../reader.config"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { MarkdownPreviewToggle } from "@/features/markdown/components/MarkdownPreviewToggle"
import { DocumentDiffView } from "@/features/markdown/components/DocumentDiffView"
import { isDocumentFile } from "@/features/markdown/helpers/documentFiles.helpers"
import { ReviewSourceCode } from "../components/ReviewSourceCode"
import { ReviewSourceFile } from "../components/ReviewSourceFile"
import {
  sourcePreviewSession,
  updateSourcePreviewSession,
  type SourceMode,
  type SourceViewHandle,
  type SourceViewPosition,
} from "../helpers/sourcePreviewSession"
import { CodeFileHeader } from "@/features/code-editor/components/CodeFileHeader"
import type {
  Change,
  CodeAnchor,
  FileContent,
  Passage,
  ReadingPosition,
  Snapshot,
} from "@/lib/desktop/contracts.generated"
import { errorMessage, reviewCommands } from "@/lib/desktop/review.commands"
import { cn } from "@/lib/utils"
import {
  SquareSplitHorizontalIcon,
  MoreHorizontalIcon,
  Search01Icon,
  Target02Icon,
  ViewIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useCallback, useEffect, useRef, useState } from "react"
import { languageName } from "../helpers/review.helpers"
import { useReviewWorkspaceStore } from "../stores/useReviewWorkspace.store"

export function ReviewCodePane({
  snapshot,
  change,
  passage,
  selection,
  stepLabel,
  position,
  onPosition,
  overlay,
  modelScope = "reader",
  source,
}: {
  /** Each simultaneous diff owns distinct Monaco models and their lifecycle. */
  modelScope?: "reader" | "reference" | "local"
  source?: FileContent
  snapshot: Pick<Snapshot, "id">
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
  const [loadedContent, setContent] = useState<FileContent | null>(null)
  const content = source ?? loadedContent
  const singleFile = !change.before || !change.after
  const SourceCode = singleFile ? ReviewSourceFile : ReviewSourceCode
  const [error, setError] = useState("")
  const [counts, setCounts] = useState<{
    added: number
    removed: number
  } | null>(null)
  const [cursor, setCursor] = useState<{ line: number; column: number } | null>(
    null
  )
  const { split, setSplit, compareCode, setCompareCode } =
    useReviewWorkspaceStore()
  const sessionKey = `${snapshot.id}/${change.id}/${modelScope}`
  const session = sourcePreviewSession(sessionKey)
  const compatible = isDocumentFile(
    change.path,
    (content?.after ?? content?.before)?.split("\n", 1)[0]
  )
  const [choice, setChoice] = useState<{
    mode: SourceMode
    resume?: boolean
    selection: CodeAnchor | null
  }>(() => ({
    mode: modelScope === "reference" ? "code" : (session.mode ?? "markdown"),
    selection,
  }))
  const markdown =
    compatible &&
    choice.mode === "markdown" &&
    (modelScope !== "reference" || choice.selection === selection)
  const view = useRef<SourceViewHandle>(null)
  const capture = useCallback(
    (value: SourceViewPosition, mode: SourceMode) => {
      updateSourcePreviewSession(sessionKey, {
        [mode]: value,
        point: value.point,
      })
    },
    [sessionKey]
  )
  const captureMarkdown = useCallback(
    (value: SourceViewPosition) => capture(value, "markdown"),
    [capture]
  )
  const captureCode = useCallback(
    (value: SourceViewPosition) => capture(value, "code"),
    [capture]
  )
  const switchMode = (mode: SourceMode) => {
    const position = view.current?.capture()
    if (position) capture(position, markdown ? "markdown" : "code")
    updateSourcePreviewSession(sessionKey, { mode })
    setChoice({ mode, selection, resume: true })
  }
  const changeLayout = (value: string) => {
    const position = view.current?.capture()
    if (position) capture(position, markdown ? "markdown" : "code")
    setSplit(value === "split")
  }
  useEffect(() => {
    if (source) return
    let alive = true
    reviewCommands
      .content(snapshot.id, change.id)
      .then((value) => {
        if (alive) setContent(value)
      })
      .catch((error) => {
        if (alive) setError(errorMessage(error))
      })
    return () => {
      alive = false
    }
  }, [snapshot.id, change.id, source])
  const { codeHeaderHeight, codeStatusHeight, contentInset } =
    reviewReaderLayout
  const padding = overlay
    ? {
        top: overlay.top + codeHeaderHeight + contentInset,
        bottom: overlay.bottom + codeStatusHeight + contentInset,
      }
    : { top: contentInset, bottom: contentInset }
  return (
    <section
      className={cn(
        "flex min-w-0 flex-col overflow-hidden",
        overlay ? "absolute inset-0" : "relative flex-1"
      )}
      aria-label="Code diff"
    >
      <CodeFileHeader
        path={change.path}
        previousPath={change.previousPath}
        className={cn(overlay && "absolute inset-x-0 z-10 glass-bar")}
        style={overlay ? { top: overlay.top } : undefined}
      >
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
        {compatible && (
          <MarkdownPreviewToggle
            active={markdown}
            disabled={!content}
            onToggle={() => switchMode(markdown ? "code" : "markdown")}
          />
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Find in file"
          disabled={!content}
          onClick={() => view.current?.find()}
        >
          <HugeiconsIcon icon={Search01Icon} size={16} />
        </Button>
        {!singleFile && markdown && (
          <Tabs
            value={split ? "split" : "unified"}
            onValueChange={changeLayout}
          >
            <TabsList>
              <TabsTrigger value="unified">Unified</TabsTrigger>
              <TabsTrigger value="split">Split</TabsTrigger>
            </TabsList>
          </Tabs>
        )}
        {!markdown && !singleFile && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={
                    compareCode ? "Hide previous code" : "Show previous code"
                  }
                  aria-pressed={compareCode}
                  className={compareCode ? "bg-accent" : undefined}
                  onClick={() => setCompareCode(!compareCode)}
                />
              }
            >
              <HugeiconsIcon icon={SquareSplitHorizontalIcon} size={16} />
            </TooltipTrigger>
            <TooltipContent>
              {compareCode ? "Hide previous code" : "Show previous code"}
            </TooltipContent>
          </Tooltip>
        )}
        {!markdown && !singleFile && (
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
        )}
      </CodeFileHeader>
      {error || content?.unavailableReason ? (
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
          {markdown ? (
            <DocumentDiffView
              key={`markdown-${!singleFile && split}`}
              before={content.before}
              after={content.after}
              split={!singleFile && split}
              diff={!singleFile}
              padding={padding}
              point={session.point}
              saved={session.markdown}
              onCapture={captureMarkdown}
              onCounts={setCounts}
              onCode={() => switchMode("code")}
              handle={view}
            />
          ) : (
            <SourceCode
              snapshot={snapshot}
              change={change}
              content={content}
              passage={passage}
              selection={selection}
              position={position}
              onPosition={onPosition}
              split={compareCode}
              onCompare={setCompareCode}
              trimWhitespace={trimWhitespace}
              padding={padding}
              modelScope={modelScope}
              point={
                modelScope === "reference" &&
                (!choice.resume || choice.selection !== selection)
                  ? undefined
                  : session.point
              }
              saved={session.code}
              onCapture={captureCode}
              onCounts={setCounts}
              onCursor={setCursor}
              handle={view}
            />
          )}
        </div>
      ) : (
        <div
          role="status"
          className="p-8 text-sm text-muted-foreground"
          style={overlay ? { paddingTop: padding.top + 24 } : undefined}
        >
          Loading content…
        </div>
      )}
      <footer
        className={cn(
          "flex h-6 shrink-0 items-center gap-4 border-t px-4 text-xs text-muted-foreground",
          overlay && "absolute inset-x-0 z-10 glass-bar"
        )}
        style={overlay ? { bottom: overlay.bottom } : undefined}
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate">
          <HugeiconsIcon icon={ViewIcon} size={14} />
          Read-only ·{" "}
          {modelScope === "local"
            ? "local changes"
            : `review files ${snapshot.id.slice(0, 6)}`}
          {!markdown && !singleFile && trimWhitespace
            ? " · filtered display"
            : ""}
        </span>
        <span>{markdown ? "Markdown" : languageName(change.path)}</span>
        <span>UTF-8</span>
        {!markdown && cursor && (
          <span className="tabular-nums">
            Ln {cursor.line}, Col {cursor.column}
          </span>
        )}
      </footer>
    </section>
  )
}
