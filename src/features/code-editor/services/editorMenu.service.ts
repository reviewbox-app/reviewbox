import { listen } from "@tauri-apps/api/event"
import { desktopAvailable } from "@/lib/desktop/review.commands"
import {
  editorError,
  getEditor,
  refreshEditor,
  saveAllEditors,
  updateEditor,
  useEditorStore,
} from "../stores/editor.store"

/** Native menu events can arrive after their workspace has left the screen. */
export function observeEditorMenu() {
  if (!desktopAvailable()) return
  let disposed = false
  const subscription = listen<[string, string]>(
    "reviewbox:editor-menu",
    ({ payload: [repository, action] }) => {
      if (
        disposed ||
        !getEditor(repository)?.ready ||
        (typeof document !== "undefined" &&
          document.querySelector('[role="dialog"], [role="alertdialog"]'))
      )
        return
      if (action === "editor.ignored") {
        updateEditor(repository, (s) => ({
          ...s,
          showIgnored: !s.showIgnored,
        }))
        void refreshEditor(repository).catch((e) => editorError(repository, e))
      } else if (action === "editor.autoSave") {
        updateEditor(repository, (s) => ({ ...s, autoSave: !s.autoSave }))
      } else if (action === "editor.saveAll") {
        void saveAllEditors(repository).catch((e) => editorError(repository, e))
      }
    }
  )
  void subscription.catch((error) => {
    if (disposed) return
    for (const [id, session] of Object.entries(
      useEditorStore.getState().sessions
    ))
      if (session.ready) editorError(id, error)
  })
  return () => {
    disposed = true
    void subscription.then((stop) => stop()).catch(() => {})
  }
}
