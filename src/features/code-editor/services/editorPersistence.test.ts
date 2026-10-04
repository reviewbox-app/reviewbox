import { expect, test } from "bun:test"
import { editorCommands } from "./editor.commands"
import { observeEditorPersistence } from "./editorLifecycle.service"
import { updateEditor, useEditorStore } from "../stores/editor.store"

test("inventory and filter changes do not write drafts or resend native dirty state", async () => {
  const original = { ...editorCommands }
  const previous = useEditorStore.getState()
  const dirtyStates: boolean[] = []
  let writes = 0
  editorCommands.dirty = async (value) => {
    dirtyStates.push(value)
  }
  editorCommands.storeRecovery = async (_, recovery) => {
    writes++
    return { ...recovery, revision: recovery.revision + 1 }
  }
  useEditorStore.setState({ sessions: {} })
  updateEditor("persistence-test", (s) => ({ ...s, ready: true }))
  const stop = observeEditorPersistence()
  try {
    await Bun.sleep(350)
    const baseline = writes
    updateEditor("persistence-test", (s) => ({
      ...s,
      entries: [{ path: "new.ts", directory: false, revision: "" }],
      filter: "new",
    }))
    await Bun.sleep(350)
    expect(writes).toBe(baseline)
    expect(dirtyStates).toEqual([false])
  } finally {
    stop()
    Object.assign(editorCommands, original)
    useEditorStore.setState(previous)
  }
})
