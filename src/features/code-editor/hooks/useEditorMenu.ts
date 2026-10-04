"use client"

import { useEffect } from "react"
import { listen } from "@tauri-apps/api/event"
import { call, desktopAvailable } from "@/lib/desktop/review.commands"
import {
  dirty,
  editorError,
  getEditor,
  refreshEditor,
  saveAllEditors,
  updateEditor,
  type EditorSession,
} from "../stores/editor.store"

let writes: Promise<unknown> = Promise.resolve()
function configure(
  repositoryId: string | null,
  showIgnored = true,
  autoSave = false,
  canSave = false
) {
  writes = writes
    .catch(() => {})
    .then(() =>
      call<void>("configure_editor_menu", {
        repositoryId,
        showIgnored,
        autoSave,
        canSave,
      })
    )
  return writes
}

export function useEditorMenu(id: string, session: EditorSession | undefined) {
  const showIgnored = session?.showIgnored ?? true
  const autoSave = session?.autoSave ?? false
  const canSave = session?.buffers.some(dirty) ?? false
  const ready = !!session?.ready
  useEffect(() => {
    if (!desktopAvailable()) return
    let disposed = false
    const subscription = listen<[string, string]>(
      "reviewbox:editor-menu",
      ({ payload: [repository, action] }) => {
        if (
          disposed ||
          repository !== id ||
          document.querySelector('[role="dialog"], [role="alertdialog"]')
        )
          return
        const current = getEditor(id)
        if (!current) return
        if (action === "editor.ignored") {
          updateEditor(id, (s) => ({ ...s, showIgnored: !s.showIgnored }))
          void refreshEditor(id).catch((e) => editorError(id, e))
        } else if (action === "editor.autoSave") {
          updateEditor(id, (s) => ({ ...s, autoSave: !s.autoSave }))
        } else if (action === "editor.saveAll") {
          void saveAllEditors(id).catch((e) => editorError(id, e))
        }
      }
    )
    void subscription.catch((e) => {
      if (!disposed) editorError(id, e)
    })
    return () => {
      disposed = true
      void subscription.then((stop) => stop()).catch(() => {})
      void configure(null).catch(() => {})
    }
  }, [id])
  useEffect(() => {
    if (desktopAvailable())
      void configure(ready ? id : null, showIgnored, autoSave, canSave).catch(
        (e) => editorError(id, e)
      )
  }, [id, ready, showIgnored, autoSave, canSave])
}
