import { editorCommands } from "./editor.commands"
import {
  dirty,
  editorError,
  editorRecovery,
  getEditor,
  recoveryVersions,
  saveBuffer,
  useEditorStore,
} from "../stores/editor.store"

let writeQueue = Promise.resolve()
let recoveryTimer: ReturnType<typeof setTimeout> | undefined
let finishing = false
const autosaves = new Map<
  string,
  { signature: string; timer: ReturnType<typeof setTimeout> }
>()

/** Serialize durable snapshots; delayed work reads current state, never an old React render. */
export async function flushEditorRecovery(discard = false) {
  clearTimeout(recoveryTimer)
  writeQueue = writeQueue
    .catch(() => {})
    .then(async () => {
      for (const [id, session] of Object.entries(
        useEditorStore.getState().sessions
      )) {
        if (!session.ready) continue
        try {
          const recovery = editorRecovery(session)
          const saved = await editorCommands.storeRecovery(id, {
            ...recovery,
            revision: recoveryVersions.get(id) ?? 0,
            drafts: discard ? [] : recovery.drafts,
          })
          recoveryVersions.set(id, saved.revision)
        } catch (error) {
          editorError(id, error)
          throw error
        }
      }
    })
  return writeQueue
}
export function setEditorFinishing(value: boolean) {
  finishing = value
  if (value) {
    clearTimeout(recoveryTimer)
    for (const pending of autosaves.values()) clearTimeout(pending.timer)
    autosaves.clear()
  }
}
export function observeEditorPersistence() {
  let previous = useEditorStore.getState().sessions
  let lastDirty: boolean | undefined
  const changed = (initial = false) => {
    if (finishing) return
    const sessions = useEditorStore.getState().sessions
    const relevant =
      initial ||
      Object.keys(previous).length !== Object.keys(sessions).length ||
      Object.entries(sessions).some(([id, s]) => {
        const old = previous[id]
        return (
          !old ||
          s.ready !== old.ready ||
          s.buffers !== old.buffers ||
          s.active !== old.active ||
          s.autoSave !== old.autoSave ||
          s.associations !== old.associations ||
          s.servers !== old.servers ||
          s.saveActions !== old.saveActions
        )
      })
    previous = sessions
    if (!relevant) return
    const isDirty = Object.values(sessions).some((s) => s.buffers.some(dirty))
    if (lastDirty !== isDirty) {
      lastDirty = isDirty
      void editorCommands.dirty(isDirty)
    }
    clearTimeout(recoveryTimer)
    recoveryTimer = setTimeout(
      () => void flushEditorRecovery().catch(() => {}),
      300
    )
    const active = new Set<string>()
    for (const [id, session] of Object.entries(sessions)) {
      if (!session.autoSave) continue
      for (const buffer of session.buffers) {
        if (!dirty(buffer) || buffer.readOnly || buffer.external !== undefined)
          continue
        const key = `${id}/${buffer.id}`
        const signature = `${buffer.path}/${buffer.version}`
        active.add(key)
        if (autosaves.get(key)?.signature === signature) continue
        clearTimeout(autosaves.get(key)?.timer)
        autosaves.set(key, {
          signature,
          timer: setTimeout(() => {
            const live = getEditor(id)?.buffers.find((b) => b.id === buffer.id)
            if (!finishing && live && live.external === undefined)
              void saveBuffer(id, buffer.id, false, "automatic").catch(
                (error) => editorError(id, error)
              )
          }, 1000),
        })
      }
    }
    for (const [key, pending] of autosaves)
      if (!active.has(key)) {
        clearTimeout(pending.timer)
        autosaves.delete(key)
      }
  }
  changed(true)
  const stop = useEditorStore.subscribe(() => changed())
  return () => {
    stop()
    clearTimeout(recoveryTimer)
    for (const pending of autosaves.values()) clearTimeout(pending.timer)
    autosaves.clear()
  }
}
