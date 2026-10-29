import { expect, test } from "bun:test"
import type { editor } from "monaco-editor"
import type { SourceSelection } from "../contracts/sourceSelection.types"
import { observeSourceSelection } from "./sourceSelection"

test("virtualized old-side selection uses original model coordinates, tracks scrolling and releases listeners", () => {
  const events = new Map<string, () => void>()
  const listen = (name: string) => (callback: () => void) => {
    events.set(name, callback)
    return {
      dispose: () => {
        events.delete(name)
      },
    }
  }
  let top = 30
  let focused = true
  let empty = false
  const source = {
    hasTextFocus: () => focused,
    getSelection: () => ({
      isEmpty: () => empty,
      startLineNumber: 27,
      startColumn: 3,
      endLineNumber: 29,
      endColumn: 5,
    }),
    getModel: () => ({ getValueInRange: () => "selected old code" }),
    getDomNode: () => ({
      getBoundingClientRect: () => ({ left: 100, top: 200, height: 180 }),
    }),
    getScrolledVisiblePosition: () => ({ left: 20, top, height: 20 }),
    onDidChangeCursorSelection: listen("selection"),
    onDidScrollChange: listen("scroll"),
    onDidLayoutChange: listen("layout"),
    onDidFocusEditorText: listen("focus"),
  } as unknown as editor.IStandaloneCodeEditor
  const received: (SourceSelection | null)[] = []
  const subscription = observeSourceSelection(source, "before", (value) =>
    received.push(value)
  )
  events.get("selection")!()
  expect(received.at(-1)).toEqual({
    side: "before",
    range: { startLine: 27, startColumn: 3, endLine: 29, endColumn: 5 },
    excerpt: "selected old code",
    position: { left: 120, top: 230, bottom: 250 },
  })
  top = -1
  events.get("scroll")!()
  expect(received.at(-1)).toBeNull()
  focused = false
  top = 20
  events.get("layout")!()
  expect(received).toHaveLength(2)
  focused = true
  empty = true
  events.get("focus")!()
  expect(received.at(-1)).toBeNull()
  subscription.dispose()
  expect(events.size).toBe(0)
})
