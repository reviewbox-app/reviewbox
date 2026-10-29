import { expect, test } from "bun:test"
import type { EditorFile } from "@/lib/desktop/contracts.generated"
import { editorCommands } from "../services/editor.commands"
import {
  editBuffer,
  editorRecovery,
  getEditor,
  keepEditorFile,
  openEditorFile,
  updateEditor,
  useEditorStore,
} from "./editor.store"

const file = (path: string): EditorFile => ({
  path,
  uri: `file:///${path}`,
  text: path,
  revision: "1",
  readOnly: false,
  reason: null,
})
test("preview replacement preserves pinned, modified and recovered buffers", async () => {
  const original = editorCommands.read
  const id = "preview-test"
  editorCommands.read = async (_, path) => file(path)
  updateEditor(id, (s) => ({ ...s, ready: true }))
  try {
    await openEditorFile(id, "a.ts", true, true)
    const replaced = getEditor(id).buffers[0].id
    expect(editorRecovery(getEditor(id)).paths).toEqual([])
    await openEditorFile(id, "b.ts", true, true)
    expect(getEditor(id).buffers.map((b) => b.path)).toEqual(["b.ts"])
    expect(getEditor(id).buffers[0].id).not.toBe(replaced)
    keepEditorFile(id, "b.ts")
    await openEditorFile(id, "a.ts", true, true)
    const a = getEditor(id).buffers.find((b) => b.path === "a.ts")!
    editBuffer(id, a.id, "changed")
    editBuffer(id, a.id, a.baseText) // Undo does not make a pinned tab temporary again.
    await openEditorFile(id, "c.ts", true, true)
    expect(getEditor(id).buffers.map((b) => [b.path, !!b.temporary])).toEqual([
      ["b.ts", false],
      ["a.ts", false],
      ["c.ts", true],
    ])
    expect(editorRecovery(getEditor(id)).paths).toEqual(["b.ts", "a.ts"])
  } finally {
    editorCommands.read = original
    useEditorStore.setState({ sessions: {} })
  }
})

test("late preview reads cannot steal focus or replace the last click", async () => {
  const original = editorCommands.read
  const id = "preview-race"
  const finish = new Map<string, (value: EditorFile) => void>()
  editorCommands.read = async (_, path) =>
    new Promise((resolve) => finish.set(path, resolve))
  updateEditor(id, (s) => ({ ...s, ready: true }))
  try {
    const first = openEditorFile(id, "slow.ts", true, true)
    const last = openEditorFile(id, "fast.ts", true, true)
    finish.get("fast.ts")!(file("fast.ts"))
    await last
    finish.get("slow.ts")!(file("slow.ts"))
    await first
    expect(getEditor(id).active).toBe("fast.ts")
    expect(getEditor(id).buffers.map((b) => b.path)).toEqual(["fast.ts"])
    const preview = openEditorFile(id, "double.ts", true, true)
    const pinned = openEditorFile(id, "double.ts")
    finish.get("double.ts")!(file("double.ts"))
    await Promise.all([preview, pinned])
    expect(
      getEditor(id).buffers.find((b) => b.path === "double.ts")?.temporary
    ).toBe(false)
  } finally {
    editorCommands.read = original
    useEditorStore.setState({ sessions: {} })
  }
})
