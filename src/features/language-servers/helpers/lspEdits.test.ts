import { expect, test } from "bun:test"
import { replaceText } from "./lspEdits"
const edit = (line: number, start: number, end: number, newText: string) => ({
  range: { start: { line, character: start }, end: { line, character: end } },
  newText,
})
test("LSP edits use UTF-16 offsets and preserve CRLF outside edited spans", () => {
  expect(
    replaceText("😀 alpha\r\nbeta\r\n", [
      edit(0, 3, 8, "gamma"),
      edit(1, 0, 4, "delta"),
    ])
  ).toBe("😀 gamma\r\ndelta\r\n")
})
test("invalid and overlapping ranges are rejected before any buffer changes", () => {
  expect(() =>
    replaceText("abc", [edit(0, 0, 2, "x"), edit(0, 1, 3, "y")])
  ).toThrow("overlapping")
  expect(() => replaceText("abc", [edit(4, 0, 1, "x")])).toThrow("invalid")
  expect(() => replaceText("abc", [edit(0, 0, 8, "x")])).toThrow("invalid")
})
