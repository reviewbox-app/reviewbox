"use client"
import { useEffect, useState } from "react"
import { subscribeRepositoryReads } from "@/lib/desktop/repositoryReads"
import { listen } from "@tauri-apps/api/event"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { desktopAvailable, errorMessage } from "@/lib/desktop/review.commands"
import { editorCommands } from "../services/editor.commands"
import {
  refreshEditor,
  saveAllEditors,
  useEditorStore,
  editorError,
} from "../stores/editor.store"
import {
  flushEditorRecovery,
  observeEditorPersistence,
  setEditorFinishing,
} from "../services/editorLifecycle.service"
import { observeLanguageRegistry } from "@/features/language-servers/services/languageRegistry.service"

/** Lives with the app, so drafts survive leaving the editor or switching checkout. */
export function EditorLifecycle() {
  const [exit, setExit] = useState(false)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  useEffect(observeLanguageRegistry, [])
  useEffect(() => {
    if (desktopAvailable()) return observeEditorPersistence()
  }, [])
  useEffect(() => {
    if (!desktopAvailable()) return
    const listener = listen("reviewbox:editor-confirm-exit", () =>
      setExit(true)
    )
    const subscriptions = new Map<string, () => void>()
    const sync = () => {
      const sessions = useEditorStore.getState().sessions
      for (const [id, stop] of subscriptions) {
        if (!sessions[id]?.ready) {
          stop()
          subscriptions.delete(id)
        }
      }
      for (const [id, session] of Object.entries(sessions)) {
        if (session.ready && !subscriptions.has(id)) {
          subscriptions.set(
            id,
            subscribeRepositoryReads(id, (change) => {
              void refreshEditor(id, change).catch((e) => editorError(id, e))
            })
          )
        }
      }
    }
    sync()
    const stopStore = useEditorStore.subscribe(sync)
    const refresh = () => {
      if (document.visibilityState !== "visible") return
      for (const [id, s] of Object.entries(useEditorStore.getState().sessions))
        if (s.ready) void refreshEditor(id).catch((e) => editorError(id, e))
    }
    const interval = setInterval(refresh, 30000)
    window.addEventListener("focus", refresh)
    return () => {
      clearInterval(interval)
      stopStore()
      for (const stop of subscriptions.values()) stop()
      window.removeEventListener("focus", refresh)
      void listener.then((stop) => stop())
    }
  }, [])
  const finish = async (save: boolean) => {
    setBusy(true)
    setError("")
    try {
      if (save) await saveAllEditors()
      setEditorFinishing(true)
      await flushEditorRecovery(true)
      await editorCommands.exit()
    } catch (e) {
      setEditorFinishing(false)
      setError(errorMessage(e))
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={exit}
      onOpenChange={(value) => {
        if (!busy) setExit(value)
      }}
    >
      <DialogContent>
        <DialogTitle>Save changes before quitting?</DialogTitle>
        <DialogDescription>
          Your open files contain unsaved changes.
        </DialogDescription>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => setExit(false)}
          >
            Cancel
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void finish(false)}
          >
            Discard changes
          </Button>
          <Button disabled={busy} onClick={() => void finish(true)}>
            Save all and quit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
