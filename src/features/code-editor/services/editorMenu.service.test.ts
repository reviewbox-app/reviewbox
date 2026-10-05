import { afterEach, expect, spyOn, test } from "bun:test"
import * as events from "@tauri-apps/api/event"
import * as desktop from "@/lib/desktop/review.commands"
import {
  dirty,
  getEditor,
  recoveryVersions,
  updateEditor,
  useEditorStore,
  type EditorBuffer,
} from "../stores/editor.store"
import { editorCommands } from "./editor.commands"
import { observeEditorMenu } from "./editorMenu.service"
import { observeEditorPersistence } from "./editorLifecycle.service"

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const stop of cleanup.splice(0).reverse()) stop()
})

function fixture() {
  const repository = `menu-test-${crypto.randomUUID()}`
  const buffer: EditorBuffer = {
    id: "file",
    path: "file.txt",
    uri: `file:///${repository}/file.txt`,
    text: "draft",
    baseText: "saved",
    version: 2,
    revision: "disk-1",
    readOnly: false,
    reason: null,
    preview: false,
  }
  updateEditor(repository, (s) => ({ ...s, ready: true, buffers: [buffer] }))
  cleanup.push(() => {
    recoveryVersions.delete(repository)
    useEditorStore.setState((s) => ({
      sessions: Object.fromEntries(
        Object.entries(s.sessions).filter(([id]) => id !== repository)
      ),
    }))
  })
  return { repository, buffer }
}

function observe() {
  let handler!: events.EventCallback<[string, string]>
  let stopped = false
  const available = spyOn(desktop, "desktopAvailable").mockReturnValue(true)
  const listen = spyOn(events, "listen").mockImplementation(
    async (_, receive) => {
      handler = receive as typeof handler
      return () => {
        stopped = true
      }
    }
  )
  cleanup.push(
    () => available.mockRestore(),
    () => listen.mockRestore()
  )
  const stop = observeEditorMenu()!
  cleanup.push(stop)
  return {
    stop,
    stopped: () => stopped,
    send: (repository: string, action: string) =>
      handler({
        event: "reviewbox:editor-menu",
        id: 0,
        payload: [repository, action],
      }),
  }
}

test("a delayed menu action targets its ready checkout after navigation and still auto-saves", async () => {
  const first = fixture()
  const second = fixture()
  const bus = observe()
  const status = spyOn(editorCommands, "dirty").mockResolvedValue(undefined)
  const recovery = spyOn(editorCommands, "storeRecovery").mockImplementation(
    async (_, value) => ({ ...value, revision: value.revision + 1 })
  )
  const read = spyOn(editorCommands, "read").mockResolvedValue({
    ...first.buffer,
    revision: "disk-2",
  })
  let persisted!: () => void
  const wrote = new Promise<void>((resolve) => {
    persisted = resolve
  })
  const mutate = spyOn(editorCommands, "mutate").mockImplementation(
    async () => {
      persisted()
    }
  )
  for (const spy of [status, recovery, read, mutate])
    cleanup.push(() => spy.mockRestore())
  cleanup.push(observeEditorPersistence())

  // The native event carries the checkout captured at click time, independently
  // from the now-visible feature or checkout. No workspace listener is mounted.
  desktop.setActiveRepository(second.repository)
  cleanup.push(() => desktop.setActiveRepository(null))
  bus.send(first.repository, "editor.autoSave")
  expect(getEditor(first.repository).autoSave).toBe(true)
  expect(getEditor(second.repository).autoSave).toBe(false)
  await wrote
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(mutate).toHaveBeenCalledTimes(1)
  expect(mutate.mock.calls[0]).toEqual([
    first.repository,
    {
      kind: "save",
      path: first.buffer.path,
      text: first.buffer.text,
      expectedRevision: first.buffer.revision,
    },
  ])
  expect(dirty(getEditor(first.repository).buffers[0])).toBe(false)
  expect(dirty(getEditor(second.repository).buffers[0])).toBe(true)
})

test("unready or disposed sessions reject delayed native actions", async () => {
  const { repository } = fixture()
  const bus = observe()
  updateEditor(repository, (s) => ({ ...s, ready: false }))
  bus.send(repository, "editor.autoSave")
  bus.send("absent-checkout", "editor.autoSave")
  expect(getEditor(repository).autoSave).toBe(false)
  expect(getEditor("absent-checkout")).toBeUndefined()
  updateEditor(repository, (s) => ({ ...s, ready: true }))
  bus.stop()
  bus.send(repository, "editor.autoSave")
  expect(getEditor(repository).autoSave).toBe(false)
  await Promise.resolve()
  expect(bus.stopped()).toBe(true)
})
