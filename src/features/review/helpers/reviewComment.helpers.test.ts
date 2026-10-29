import { expect, test } from "bun:test"
import type { Change } from "@/lib/desktop/contracts.generated"
import type { SourceSelection } from "@/features/code-editor/contracts/sourceSelection.types"
import { commentAnchor, commentLocation } from "./reviewComment.helpers"

const selection: SourceSelection = {
  side: "before",
  range: { startLine: 3, startColumn: 2, endLine: 4, endColumn: 7 },
  excerpt: "old 😀 code",
  position: { left: 100, top: 100, bottom: 120 },
}
const change = {
  id: "rename",
  path: "new.ts",
  previousPath: "old.ts",
  before: { hash: "old" },
  after: { hash: "new" },
} as Change
test("comments retain the selected immutable side, original rename path and UTF-16 range", () => {
  const before = commentAnchor("capture", change, selection)!
  expect(before).toEqual({
    snapshotId: "capture",
    sourceId: "change:rename:before",
    path: "old.ts",
    contentHash: "old",
    range: selection.range,
    excerpt: selection.excerpt,
  })
  expect(commentLocation(before)).toBe("old.ts · before · 3:2–4:7")
  const after = commentAnchor("capture", change, {
    ...selection,
    side: "after",
  })!
  expect(after.path).toBe("new.ts")
  expect(after.contentHash).toBe("new")
})
test("deleted sources remain commentable without inventing a current file", () => {
  const deleted = { ...change, after: null }
  expect(commentAnchor("capture", deleted, selection)?.path).toBe("old.ts")
  expect(
    commentAnchor("capture", deleted, { ...selection, side: "after" })
  ).toBeUndefined()
})
