import { expect, test } from "bun:test"
import {
  codeBlocks,
  currentLine,
  containingBlock,
  wordRanges,
} from "./blockDiff.helpers"

const blocks = codeBlocks([
  {
    charChanges: undefined,
    originalStartLineNumber: 1,
    originalEndLineNumber: 2,
    modifiedStartLineNumber: 0,
    modifiedEndLineNumber: 0,
  },
  {
    charChanges: undefined,
    originalStartLineNumber: 10,
    originalEndLineNumber: 12,
    modifiedStartLineNumber: 8,
    modifiedEndLineNumber: 12,
  },
  {
    charChanges: undefined,
    originalStartLineNumber: 20,
    originalEndLineNumber: 0,
    modifiedStartLineNumber: 21,
    modifiedEndLineNumber: 22,
  },
])
test("changes preserve whole ranges, unequal replacements and start-of-file deletions", () => {
  expect(blocks[0]).toMatchObject({
    before: { start: 1, end: 2 },
    after: null,
    anchor: 0,
  })
  expect(blocks[1]).toMatchObject({
    before: { start: 10, end: 12 },
    after: { start: 8, end: 12 },
    anchor: 7,
  })
  expect(containingBlock(blocks, "before", 11)).toBe(blocks[1])
  expect(containingBlock(blocks, "after", 13)).toBeUndefined()
})
test("unchanged old lines map through preceding removals and insertions", () => {
  expect(currentLine(blocks, 3)).toBe(1)
  expect(currentLine(blocks, 13)).toBe(13)
  expect(currentLine(blocks, 21)).toBe(23)
})

test("inline differences expand identifiers and group adjacent changed words", () => {
  const text = 'const currentOnlyValue = "deux mots";'
  const ranges = wordRanges(
    [text],
    [
      { startLineNumber: 1, endLineNumber: 1, startColumn: 7, endColumn: 10 },
      { startLineNumber: 1, endLineNumber: 1, startColumn: 27, endColumn: 30 },
      { startLineNumber: 1, endLineNumber: 1, startColumn: 32, endColumn: 35 },
    ]
  )
  expect(
    ranges.map((r) => text.slice(r.startColumn - 1, r.endColumn - 1))
  ).toEqual(["currentOnlyValue", "deux mots"])
})
test("whitespace-only edits, indentation and wide spacing stay unmarked", () => {
  const text = "  café  neuf\tété 😀"
  const all = wordRanges(
    [text],
    [
      {
        startLineNumber: 1,
        endLineNumber: 1,
        startColumn: 1,
        endColumn: text.length + 1,
      },
    ]
  )
  expect(
    all.map((r) => text.slice(r.startColumn - 1, r.endColumn - 1))
  ).toEqual(["café", "neuf", "été 😀"])
  expect(
    wordRanges(
      [text],
      [{ startLineNumber: 1, endLineNumber: 1, startColumn: 7, endColumn: 9 }]
    )
  ).toEqual([])
})
test("new and deleted blocks have no extra word decorations", () => {
  const result = codeBlocks(
    [
      {
        originalStartLineNumber: 0,
        originalEndLineNumber: 0,
        modifiedStartLineNumber: 1,
        modifiedEndLineNumber: 1,
        charChanges: undefined,
      },
    ],
    { before: "", after: "added" }
  )
  expect(result[0].words).toBeUndefined()
})
