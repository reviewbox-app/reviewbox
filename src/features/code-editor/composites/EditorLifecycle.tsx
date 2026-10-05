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
  updateEditor,
} from "../stores/editor.store"
import {
  flushEditorRecovery,
  observeEditorPersistence,
  setEditorFinishing,
} from "../services/editorLifecycle.service"
import { observeLanguageRegistry } from "@/features/language-servers/services/languageRegistry.service"
import { observeEditorMenu } from "../services/editorMenu.service"

/** Lives with the app, so drafts survive leaving the editor or switching checkout. */
export function EditorLifecycle() {
  const [exit, setExit] = useState(false)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  useEffect(observeLanguageRegistry, [])
  useEffect(observeEditorMenu, [])
  useEffect(() => {
    if (desktopAvailable()) return observeEditorPersistence()
  }, [])
  useEffect(() => {
    if (!desktopAvailable()) return
    const listener = listen("reviewbox:editor-confirm-exit", () =>
      setExit(true)
    )
    const subscriptions = new Map<string, () => void>()
    const fallbacks = new Map<string, ReturnType<typeof setTimeout>>()
    const revisions = new Map<
      string,
      { generation: string; sequence: number }
    >()
    let disposed = false
    const check = async (id: string, fallback = false) => {
      if (disposed || document.visibilityState !== "visible") return
      try {
        const status = await editorCommands.watchStatus(id)
        if (disposed || !subscriptions.has(id)) return
        updateEditor(id, (session) =>
          session.watchHealthy === status.healthy
            ? session
            : { ...session, watchHealthy: status.healthy }
        )
        const previous = revisions.get(id)
        const missed = previous
          ? previous.generation !== status.generation ||
            status.sequence > previous.sequence
          : status.sequence > 0
        revisions.set(id, status)
        const session = useEditorStore.getState().sessions[id]
        if (session?.ready)
          await refreshEditor(
            id,
            fallback || missed
              ? undefined
              : {
                  repositoryId: id,
                  paths: session.buffers
                    .filter((buffer) => !buffer.path.startsWith("file:"))
                    .map((buffer) => buffer.path),
                  tree: false,
                  git: false,
                  full: false,
                }
          )
        clearTimeout(fallbacks.get(id))
        fallbacks.delete(id)
        if (!status.healthy && !disposed)
          fallbacks.set(
            id,
            setTimeout(() => void check(id, true), 30000)
          )
      } catch (error) {
        if (!disposed) {
          updateEditor(id, (session) => ({ ...session, watchHealthy: false }))
          editorError(id, error)
          clearTimeout(fallbacks.get(id))
          fallbacks.set(
            id,
            setTimeout(() => void check(id, true), 30000)
          )
        }
      }
    }
    const sync = () => {
      const sessions = useEditorStore.getState().sessions
      for (const [id, stop] of subscriptions) {
        if (!sessions[id]?.ready) {
          stop()
          subscriptions.delete(id)
          clearTimeout(fallbacks.get(id))
          fallbacks.delete(id)
          revisions.delete(id)
        }
      }
      for (const [id, session] of Object.entries(sessions)) {
        if (session.ready && !subscriptions.has(id)) {
          subscriptions.set(
            id,
            subscribeRepositoryReads(id, (change) => {
              if (change.generation && change.sequence !== undefined)
                revisions.set(id, {
                  generation: change.generation,
                  sequence: change.sequence,
                })
              void refreshEditor(id, change).catch((e) => editorError(id, e))
              if (change.full) void check(id)
            })
          )
          // Native registration is asynchronous. Health checks only enable a bounded fallback if unavailable.
          fallbacks.set(
            id,
            setTimeout(() => void check(id), 1000)
          )
        }
      }
    }
    sync()
    const stopStore = useEditorStore.subscribe(sync)
    const refresh = () => {
      for (const id of subscriptions.keys()) void check(id)
    }
    window.addEventListener("focus", refresh)
    document.addEventListener("visibilitychange", refresh)
    return () => {
      disposed = true
      stopStore()
      for (const stop of subscriptions.values()) stop()
      for (const timer of fallbacks.values()) clearTimeout(timer)
      window.removeEventListener("focus", refresh)
      document.removeEventListener("visibilitychange", refresh)
      void listener.then((stop) => stop())
    }
  }, [])
  const finish = async (save: boolean) => {
    setBusy(true)
    setError("")
    try {
      if (save) await saveAllEditors(undefined, "close")
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
