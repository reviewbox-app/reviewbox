import { expect, test } from "bun:test"
import { runSaveActions, type SaveSnapshot } from "./saveActions"

function buffer(text = "original") {
  let value: SaveSnapshot = { text, version: 1 }
  return {
    read: () => value,
    apply: (before: SaveSnapshot, text: string) => {
      if (before.version !== value.version) return
      value = { text, version: value.version + 1 }
      return value
    },
    type: (text: string) => {
      value = { text, version: value.version + 1 }
    },
  }
}
test("imports are synchronized before formatting the resulting text", async () => {
  const state = buffer()
  await runSaveActions({
    ...state,
    warn: () => {},
    actions: [
      async (s) => `${s.text}+imports`,
      async (s) => {
        expect(s.text).toBe("original+imports")
        return `${s.text}+format`
      },
    ],
  })
  expect(state.read().text).toBe("original+imports+format")
})
test("typing invalidates a pending transformation without losing input", async () => {
  const state = buffer()
  const warnings: unknown[] = []
  await runSaveActions({
    ...state,
    warn: (e) => warnings.push(e),
    actions: [
      async () => {
        state.type("user input")
        return "stale server edit"
      },
    ],
  })
  expect(state.read().text).toBe("user input")
  expect(warnings).toHaveLength(1)
})
test("timeout rolls back only our transformations and ignores late responses", async () => {
  const state = buffer()
  let complete!: (s: string) => void
  await runSaveActions({
    ...state,
    timeoutMs: 5,
    warn: () => {},
    actions: [
      async () => "imports",
      async () =>
        new Promise<string>((resolve) => {
          complete = resolve
        }),
    ],
  })
  expect(state.read().text).toBe("original")
  complete("late formatting")
  await Promise.resolve()
  expect(state.read().text).toBe("original")
})
test("failure after resumed typing never rolls back the user's edits", async () => {
  const state = buffer()
  await runSaveActions({
    ...state,
    warn: () => {},
    actions: [
      async () => "imports",
      async () => {
        state.type("imports and user input")
        throw new Error("server crashed")
      },
    ],
  })
  expect(state.read().text).toBe("imports and user input")
})
