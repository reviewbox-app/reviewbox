import { afterEach, expect, spyOn, test } from "bun:test"
import type { EditorFile } from "@/lib/desktop/contracts.generated"
import * as languageServices from "@/features/language-servers/services/liveMonaco"
import { liveCommands } from "@/features/language-servers/services/liveLanguage.commands"
import { editorCommands } from "../services/editor.commands"
import {
  dirty,
  editBuffer,
  getEditor,
  saveAllEditors,
  saveBuffer,
  updateEditor,
  useEditorStore,
  type EditorBuffer,
} from "./editor.store"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})
function fixture() {
  const repository = `save-test-${crypto.randomUUID()}`
  const buffer: EditorBuffer = {
    id: "file",
    path: "main.ts",
    uri: `file:///${repository}/main.ts`,
    text: "edited text",
    baseText: "saved text",
    version: 2,
    revision: "disk-1",
    readOnly: false,
    reason: null,
    preview: false,
  }
  let disk: EditorFile = { ...buffer, text: buffer.baseText }
  updateEditor(repository, (s) => ({ ...s, ready: true, buffers: [buffer] }))
  const read = spyOn(editorCommands, "read").mockImplementation(
    async () => disk
  )
  const mutate = spyOn(editorCommands, "mutate").mockImplementation(
    async (_, mutation) => {
      if (mutation.kind !== "save") throw new Error("Only save expected")
      expect(mutation.expectedRevision).toBe(disk.revision)
      disk = { ...disk, text: mutation.text, revision: "disk-2" }
    }
  )
  cleanups.push(() => {
    read.mockRestore()
    mutate.mockRestore()
    useEditorStore.setState((s) => ({
      sessions: Object.fromEntries(
        Object.entries(s.sessions).filter(([id]) => id !== repository)
      ),
    }))
  })
  return {
    repository,
    buffer,
    read,
    mutate,
    current: () => getEditor(repository).buffers[0],
  }
}

test("auto-save writes the current text without calling language transformations", async () => {
  const f = fixture()
  const prepare = spyOn(languageServices, "prepareLiveSave").mockImplementation(
    async () => {
      throw new Error("Auto-save must not invoke the language service")
    }
  )
  cleanups.push(() => prepare.mockRestore())
  await saveBuffer(f.repository, f.buffer.id, false, "automatic")
  expect(prepare).not.toHaveBeenCalled()
  expect(f.mutate.mock.calls[0][1]).toMatchObject({ text: "edited text" })
  expect(dirty(f.current())).toBe(false)
})

test("manual save remains operational with no bound language server and starts no server", async () => {
  const f = fixture()
  const open = spyOn(liveCommands, "open").mockImplementation(async () => {
    throw new Error("A manual save must not start a server")
  })
  cleanups.push(() => open.mockRestore())
  await saveBuffer(f.repository, f.buffer.id)
  expect(open).not.toHaveBeenCalled()
  expect(f.mutate).toHaveBeenCalledTimes(1)
  expect(f.current().baseText).toBe("edited text")
  expect(f.current().revision).toBe("disk-2")
})

test("Save all writes the transformed buffer returned by the bounded language stage", async () => {
  const f = fixture()
  const prepare = spyOn(languageServices, "prepareLiveSave").mockImplementation(
    async (repository, key) => {
      editBuffer(repository, key, "organized and formatted text")
    }
  )
  cleanups.push(() => prepare.mockRestore())
  await saveAllEditors(f.repository)
  expect(prepare).toHaveBeenCalledWith(f.repository, f.buffer.id)
  expect(f.mutate.mock.calls[0][1]).toMatchObject({
    text: "organized and formatted text",
  })
  expect(dirty(f.current())).toBe(false)
})

test("typing during a disk write is retained as a dirty buffer after that save completes", async () => {
  const f = fixture()
  let release!: () => void
  let started!: () => void
  const writing = new Promise<void>((resolve) => {
    started = resolve
  })
  f.mutate.mockImplementation(async () => {
    started()
    await new Promise<void>((resolve) => {
      release = resolve
    })
  })
  f.read.mockImplementation(async () => ({ ...f.buffer, revision: "disk-2" }))
  const saving = saveBuffer(f.repository, f.buffer.id, false, "automatic")
  await writing
  editBuffer(f.repository, f.buffer.id, "new input while saving")
  release()
  await saving
  expect(f.current().text).toBe("new input while saving")
  expect(f.current().baseText).toBe("edited text")
  expect(f.current().revision).toBe("disk-2")
  expect(dirty(f.current())).toBe(true)
})
