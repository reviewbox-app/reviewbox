import { afterEach, expect, spyOn, test } from "bun:test"
import type * as M from "monaco-editor/editor/editor.api"
import * as commands from "@/lib/desktop/review.commands"
import { ensureEngine, retryEngine, useEditorEngines } from "./engines"
import { useExtensionsStore } from "./extensions.store"
import { formatModel } from "./formatting"

const defaults = useExtensionsStore.getState().preferences
const restore: (() => void)[] = []
afterEach(() => {
  restore.splice(0).forEach((dispose) => dispose())
  useEditorEngines.setState({ engines: {}, revision: 0 })
  useExtensionsStore.setState({ preferences: defaults })
})
function native(invoke: (command: string) => Promise<unknown>) {
  const available = spyOn(commands, "desktopAvailable").mockReturnValue(true)
  const call = spyOn(commands, "call").mockImplementation(
    invoke as typeof commands.call
  )
  restore.push(
    () => available.mockRestore(),
    () => call.mockRestore()
  )
  return call
}
test("failed engine downloads require Retry and an installed engine is reused offline", async () => {
  let fail = true
  const calls = native(async () => {
    if (fail) throw new Error("Network unavailable")
    return null
  })
  await expect(ensureEngine("tailwind")).rejects.toThrow("Network unavailable")
  await expect(ensureEngine("tailwind")).rejects.toThrow("Network unavailable")
  expect(calls).toHaveBeenCalledTimes(1)
  fail = false
  await retryEngine("tailwind")
  expect(useEditorEngines.getState().engines.tailwind.phase).toBe("ready")
  await ensureEngine("tailwind")
  expect(calls).toHaveBeenCalledTimes(2)
})
test("disabling an extension during installation cannot publish ready", async () => {
  native(async (command) =>
    command === "ensure_editor_engine"
      ? { id: "install", serverId: "tailwind", status: "queued" }
      : {
          entries: [],
          operations: [{ id: "install", status: "ready", message: "Ready" }],
        }
  )
  const install = ensureEngine("tailwind")
  expect(ensureEngine("tailwind")).toBe(install)
  useExtensionsStore.setState({
    preferences: {
      ...defaults,
      enabled: { ...defaults.enabled, tailwind: false },
    },
  })
  await expect(install).rejects.toThrow("disabled")
  expect(useEditorEngines.getState().engines.tailwind.phase).toBe("failed")
})
test("late manual formatting is discarded after typing or disabling Prettier", async () => {
  let resolve!: (text: string) => void
  native(async (command) =>
    command === "ensure_editor_engine"
      ? null
      : new Promise<string>((done) => {
          resolve = done
        })
  )
  let version = 1
  const model = {
    getVersionId: () => version,
    getValue: () => "const value=1",
    isDisposed: () => false,
    getFullModelRange: () => ({
      startLineNumber: 1,
      endLineNumber: 1,
      startColumn: 1,
      endColumn: 14,
    }),
  } as M.editor.ITextModel
  const token = { isCancellationRequested: false } as M.CancellationToken
  const pending = formatModel(model, "repo", "main.ts", token)
  await new Promise((resolve) => setImmediate(resolve))
  version++
  resolve("const value = 1;\n")
  expect(await pending).toEqual([])
  const disabled = formatModel(model, "repo", "main.ts", token)
  await new Promise((resolve) => setImmediate(resolve))
  useExtensionsStore.setState({
    preferences: {
      ...defaults,
      enabled: { ...defaults.enabled, prettier: false },
    },
  })
  resolve("const value = 1;\n")
  expect(await disabled).toEqual([])
})
