import { expect, test } from "bun:test"
import { changeDecorations } from "./changeDecorations"

test("Git gutter distinguishes inserted, replaced and deleted lines including deletion at start", () => {
  const changes = changeDecorations(
    "removed\nkeep\nold\ntail\n",
    "keep\nnew\ntail\nadded\n"
  )
  expect(
    changes.map((c) => [
      c.options.linesDecorationsClassName,
      c.range.startLineNumber,
      c.range.endLineNumber,
    ])
  ).toEqual([
    ["reviewbox-change-deleted", 1, 1],
    ["reviewbox-change-modified", 2, 2],
    ["reviewbox-change-added", 4, 4],
  ])
})
test("identical text and line endings create no spurious markers; large input is bounded", () => {
  expect(changeDecorations("a\r\nb\r\n", "a\nb\n")).toEqual([])
  expect(changeDecorations("", "first\nsecond\n")[0].range.endLineNumber).toBe(
    2
  )
  expect(changeDecorations("x".repeat(4_000_001), "")).toEqual([])
})
