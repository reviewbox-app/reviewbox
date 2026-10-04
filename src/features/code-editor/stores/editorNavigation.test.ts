import { expect, test } from "bun:test"
import { editorCommands } from "../services/editor.commands"
import {
  getEditor,
  openEditorFile,
  updateEditor,
  useEditorStore,
} from "./editor.store"
import type { EditorFile } from "@/lib/desktop/contracts.generated"

test("explicit file selection activates an in-flight background search result without duplicating the buffer", async () => {
  const id = "navigation-race-test"
  updateEditor(id, (s) => ({ ...s, ready: true, active: "previous.ts" }))
  const original = editorCommands.read
  let resolve!: (file: EditorFile) => void
  editorCommands.read = () =>
    new Promise((done) => {
      resolve = done
    })
  try {
    const background = openEditorFile(id, "found.ts", false)
    const select = openEditorFile(id, "found.ts")
    expect(getEditor(id).active).toBe("previous.ts")
    resolve({
      path: "found.ts",
      uri: "file:///found.ts",
      text: "needle",
      revision: "1",
      readOnly: false,
      reason: null,
    })
    await Promise.all([background, select])
    expect(getEditor(id).active).toBe("found.ts")
    expect(getEditor(id).buffers).toHaveLength(1)
  } finally {
    editorCommands.read = original
    useEditorStore.setState((s) => ({
      sessions: Object.fromEntries(
        Object.entries(s.sessions).filter(([key]) => key !== id)
      ),
    }))
  }
})
