import type {
  Change,
  CodeCommentAnchor,
  ReviewCommentAnchor,
} from "@/lib/desktop/contracts.generated"
import type { SourceSelection } from "@/features/code-editor/contracts/sourceSelection.types"

export function commentAnchor(
  snapshotId: string,
  change: Change,
  selection: SourceSelection
): CodeCommentAnchor | undefined {
  const source = change[selection.side]
  if (!source) return
  return {
    snapshotId,
    sourceId: `change:${change.id}:${selection.side}`,
    path:
      selection.side === "before"
        ? (change.previousPath ?? change.path)
        : change.path,
    contentHash: source.hash,
    range: selection.range,
    excerpt: selection.excerpt,
  }
}
export function commentLocation(anchor: ReviewCommentAnchor) {
  if ("document" in anchor)
    return `${anchor.title ?? "Document"} · ${anchor.document.level}`
  const range = anchor.range
  const side =
    anchor.local?.side ??
    (anchor.sourceId.endsWith(":before") ? "before" : "after")
  return `${anchor.path} · ${anchor.local ? `${anchor.local.layer} · ` : ""}${side} · ${range.startLine}:${range.startColumn}–${range.endLine}:${range.endColumn}`
}
