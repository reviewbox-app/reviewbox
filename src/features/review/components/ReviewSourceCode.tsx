"use client"
import { useMemo, useRef, useImperativeHandle } from "react"
import type { Ref } from "react"
import type { BlockDiffHandle } from "@/features/code-editor/contracts/blockDiff.types"
import type { SourceSelection } from "@/features/code-editor/contracts/sourceSelection.types"
import { BlockDiff } from "@/features/code-editor/components/BlockDiff"
import type { SourceReadingPoint } from "@/features/markdown/contracts/documentDiff.types"
import type {
  Change,
  CodeAnchor,
  FileContent,
  Passage,
  ReadingPosition,
  Snapshot,
} from "@/lib/desktop/contracts.generated"
import { languageFor } from "../helpers/review.helpers"
import { reviewReaderLayout } from "../reader.config"
import type {
  SourceViewHandle,
  SourceViewPosition,
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
  onCompare,
  trimWhitespace,
  padding,
  modelScope,
  point,
  saved,
  onCapture,
  onCounts,
  onCursor,
  handle,
  onCommentSelection,
}: {
  snapshot: Pick<Snapshot, "id">
  change: Change
  content: FileContent
  passage?: Passage
  selection: CodeAnchor | null
  position: ReadingPosition
  onPosition: (position: ReadingPosition) => void
  split: boolean
  onCompare?: (value: boolean) => void
  trimWhitespace: boolean
  padding: { top: number; bottom: number }
  modelScope: "reader" | "reference" | "local"
  point?: SourceReadingPoint
  saved?: SourceViewPosition
  onCapture: (value: SourceViewPosition) => void
  onCounts: (value: { added: number; removed: number }) => void
  onCursor: (value: { line: number; column: number }) => void
  handle: Ref<SourceViewHandle>
  onCommentSelection?: (selection: SourceSelection | null) => void
}) {
  const view = useRef<BlockDiffHandle>(null)
  useImperativeHandle(
    handle,
    () => ({
      find: () => view.current?.find(),
      capture: () => {
        const point = view.current?.capture()
        return point ? { point, split } : undefined
      },
    }),
    [split]
  )
  const {
    newLines = 0,
    newStart = 0,
    oldLines = 0,
    oldStart = 0,
  } = passage ?? {}
  const target = useMemo(() => {
    if (!selection || (!newLines && !oldLines)) return undefined
    const side = newLines ? ("after" as const) : ("before" as const)
    const start = newLines ? newStart : oldStart
    return {
      side,
      start,
      end: start + Math.max(newLines || oldLines, 1) - 1,
      identity: selection,
    }
  }, [newLines, newStart, oldLines, oldStart, selection])
  const resume =
    point ??
    saved?.point ??
    (position.changeId === change.id && position.line > 0
      ? { side: "after" as const, line: position.line, fraction: 0 }
      : undefined)
  return (
    <BlockDiff
      onCommentSelection={onCommentSelection}
      key={`${snapshot.id}/${change.id}/${modelScope}`}
      before={content.before ?? ""}
      after={content.after ?? ""}
      language={languageFor(change.path)}
      modelPath={`reviewbox://${snapshot.id}/${change.id}/${modelScope}/${change.path}`}
      beforeDocument={
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
      afterDocument={
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
      compare={split}
      onCompare={onCompare ?? (() => {})}
      trimWhitespace={trimWhitespace}
      overlayTop={Math.max(0, padding.top - reviewReaderLayout.contentInset)}
      inset={Math.min(padding.top, reviewReaderLayout.contentInset)}
      bottom={padding.bottom}
      point={resume}
      target={target}
      handle={view}
      onCapture={(point) => {
        onCapture({ point, split })
        onPosition({
          ...position,
          changeId: change.id,
          passageId: passage?.id ?? null,
          line: point.line,
          scrollTop: 0,
        })
      }}
      onCounts={onCounts}
      onCursor={onCursor}
    />
  )
}
