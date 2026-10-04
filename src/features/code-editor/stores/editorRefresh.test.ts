import { expect, test } from "bun:test"
import { editorCommands } from "../services/editor.commands"
import {
  getEditor,
  openEditorFile,
  refreshEditor,
  updateEditor,
  useEditorStore,
} from "./editor.store"
import type { RepositoryReadChange } from "@/lib/desktop/contracts.generated"
const change = (paths: string[]): RepositoryReadChange => ({
  repositoryId: "refresh-test",
  paths,
  tree: false,
  git: false,
  full: false,
})

test("refresh preserves unchanged state, scopes disk reads and drains events received during a read", async () => {
  const id = "refresh-test"
  const original = { ...editorCommands }
  const reads: string[] = []
  let inventories = 0
  let hold: (() => Promise<void>) | undefined
  editorCommands.inventory = async () => {
    inventories++
    return [
      { path: "a.ts", directory: false, revision: "" },
      { path: "b.ts", directory: false, revision: "" },
    ]
  }
  editorCommands.read = async (_, path) => {
    reads.push(path)
    const wait = hold
    hold = undefined
    await wait?.()
    return {
      path,
      uri: `file:///${path}`,
      text: "saved",
      revision: "1",
      readOnly: false,
      reason: null,
    }
  }
  try {
    updateEditor(id, (s) => ({ ...s, ready: true }))
    await openEditorFile(id, "a.ts")
    await openEditorFile(id, "b.ts")
    await refreshEditor(id)
    const stable = getEditor(id)
    await refreshEditor(id)
    expect(getEditor(id)).toBe(stable)
    reads.length = 0
    inventories = 0
    await refreshEditor(id, change(["closed.ts"]))
    expect(reads).toEqual([])
    expect(inventories).toBe(0)
    await refreshEditor(id, { ...change([]), tree: true, git: true })
    expect(reads).toEqual([])
    expect(getEditor(id)).toBe(stable)
    let release!: () => void
    hold = () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
    const first = refreshEditor(id, change(["a.ts"]))
    const second = refreshEditor(id, change(["b.ts"]))
    release()
    await Promise.all([first, second])
    expect(reads).toEqual(["a.ts", "b.ts"])
    expect(getEditor(id)).toBe(stable)
  } finally {
    Object.assign(editorCommands, original)
    useEditorStore.setState((s) => ({
      sessions: Object.fromEntries(
        Object.entries(s.sessions).filter(([key]) => key !== id)
      ),
    }))
  }
})
