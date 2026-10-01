import { expect, test } from "bun:test"
import type { editor } from "monaco-editor"
import { revealPassage } from "./revealPassage.helpers"

test("references center the whole range between floating bars, including wrapped heights", () => {
  let scroll = -1
  const instance = {
    getLayoutInfo: () => ({ height: 900 }),
    getTopForLineNumber: (line: number) => (line === 20 ? 1000 : 2000),
    getBottomForLineNumber: () => 1100,
    setScrollTop: (value: number) => {
      scroll = value
    },
  } as unknown as editor.IStandaloneCodeEditor
  revealPassage(instance, 20, 24, { top: 100, bottom: 60 })
  expect(scroll).toBe(580)
  instance.getBottomForLineNumber = () => 2500
  revealPassage(instance, 20, 80, { top: 100, bottom: 60 })
  expect(scroll).toBe(530)
})
