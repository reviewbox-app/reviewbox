"use client"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { editorCommands } from "../services/editor.commands"
import {
  editorError,
  getEditor,
  refreshEditor,
  updateEditor,
} from "../stores/editor.store"

export function EditorWatchNotice({ repositoryId }: { repositoryId: string }) {
  const [busy, setBusy] = useState(false)
  const retry = async () => {
    setBusy(true)
    try {
      let status = await editorCommands.watchStatus(repositoryId)
      // Registration happens off the command thread. Give it one bounded retry.
      if (!status.healthy) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        status = await editorCommands.watchStatus(repositoryId)
      }
      if (!getEditor(repositoryId)?.ready) return
      updateEditor(repositoryId, (session) => ({
        ...session,
        watchHealthy: status.healthy,
      }))
      if (status.healthy) await refreshEditor(repositoryId)
    } catch (error) {
      editorError(repositoryId, error)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div
      role="status"
      className="flex items-center gap-2 px-4 py-2 text-xs text-muted-foreground"
    >
      <span className="flex-1">
        File watching is unavailable. Changes are checked periodically.
      </span>
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={() => void retry()}
      >
        {busy ? "Reconnecting…" : "Retry file watching"}
      </Button>
    </div>
  )
}
