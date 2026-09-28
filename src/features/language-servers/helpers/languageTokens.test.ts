import { expect, test } from "bun:test"
import {
  monacoRange,
  remapSemanticTokens,
  semanticTokenTypes,
  semanticTokenModifiers,
} from "./languageTokens"

test("server legends and modifiers map without shifting later token coordinates", () => {
  const result = remapSemanticTokens(
    {
      tokenTypes: ["parameter", "vendorUnknown", "function"],
      tokenModifiers: ["defaultLibrary", "readonly"],
      data: [0, 2, 3, 0, 2, 0, 4, 2, 1, 0, 1, 5, 4, 2, 1],
    },
    [12, 20]
  )
  expect([...result]).toEqual([
    0,
    2,
    3,
    semanticTokenTypes.indexOf("parameter"),
    1 << semanticTokenModifiers.indexOf("readonly"),
    1,
    5,
    4,
    semanticTokenTypes.indexOf("function"),
    1 << semanticTokenModifiers.indexOf("defaultLibrary"),
  ])
})

test("invalid and out-of-range token spans never decorate other captured text", () => {
  const legend = { tokenTypes: ["variable"], tokenModifiers: [] }
  expect(remapSemanticTokens({ ...legend, data: [0, 1] }, [10]).length).toBe(0)
  expect(
    remapSemanticTokens(
      { ...legend, data: [0, 0, 5, 0, 0, 0, 6, 2, 0, 0] },
      [7]
    ).length
  ).toBe(5)
  expect(
    remapSemanticTokens({ ...legend, data: [-1, 0, 1, 0, 0] }, [7]).length
  ).toBe(0)
  // UTF-16 columns, including astral characters, are preserved rather than counted as codepoints.
  expect(
    [
      ...remapSemanticTokens({ ...legend, data: [0, 2, 1, 0, 0] }, [
        "😀x".length,
      ]),
    ].slice(0, 3)
  ).toEqual([0, 2, 1])
})

test("native exclusive ranges map directly into Monaco without losing the final character", () => {
  expect(
    monacoRange({ startLine: 3, startColumn: 2, endLine: 3, endColumn: 6 })
  ).toEqual({
    startLineNumber: 3,
    startColumn: 2,
    endLineNumber: 3,
    endColumn: 6,
  })
})
