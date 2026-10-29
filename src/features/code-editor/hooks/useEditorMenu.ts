"use client"

import { useEffect } from "react"
import { call, desktopAvailable } from "@/lib/desktop/review.commands"
import { dirty, editorError, type EditorSession } from "../stores/editor.store"

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
    return () => {
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
