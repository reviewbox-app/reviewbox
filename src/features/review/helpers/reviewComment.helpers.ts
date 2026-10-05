import type {
  Change,
  ReviewCommentAnchor,
} from "@/lib/desktop/contracts.generated"
import type { SourceSelection } from "@/features/code-editor/contracts/sourceSelection.types"

export function commentAnchor(
  snapshotId: string,
  change: Change,
  selection: SourceSelection
): ReviewCommentAnchor | undefined {
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
  const range = anchor.range
  const side = anchor.sourceId.endsWith(":before") ? "before" : "after"
  return `${anchor.path} · ${side} · ${range.startLine}:${range.startColumn}–${range.endLine}:${range.endColumn}`
}
