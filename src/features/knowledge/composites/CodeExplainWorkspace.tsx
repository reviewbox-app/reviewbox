"use client"
import { useEffect, useRef, useState } from "react"
import type { Snapshot } from "@/lib/desktop/contracts.generated"
import {
  hasSourceChanges,
  subscribeRepositoryReads,
} from "@/lib/desktop/repositoryReads"
import { errorMessage } from "@/lib/desktop/review.commands"
import { Button } from "@/components/ui/button"
import { contexts, contextCommands } from "../services/context.commands"
import { UnderstandWorkspace } from "./UnderstandWorkspace"

/** Current repository sources, independent of the selected review. */
export function CodeExplainWorkspace({
  repositoryId,
  onError,
}: {
  repositoryId: string
  onError: (error: string) => void
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(
    () => contexts.get(repositoryId) ?? null
  )
  const displayed = useRef(snapshot?.id)
  useEffect(() => {
    const previous = displayed.current
    displayed.current = snapshot?.id
    if (previous && snapshot && previous !== snapshot.id) {
      void contextCommands.release(repositoryId, previous).catch(() => {})
    }
  }, [repositoryId, snapshot])
  const [refreshing, setRefreshing] = useState(true)
  const [error, setError] = useState("")
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let alive = true
    let running = false
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      if (running) return
      clearTimeout(timer)
      running = true
      if (alive && !displayed.current) setRefreshing(true)
      try {
        const value = await contextCommands.refresh(repositoryId)
        if (alive) {
          setSnapshot((previous) =>
            previous?.id === value.id ? previous : value
          )
          setError("")
        }
      } catch (cause) {
        if (alive) setError(errorMessage(cause))
      } finally {
        running = false
        if (alive) {
          setRefreshing(false)
          timer = setTimeout(refresh, 30000)
        }
      }
    }
    const focus = () => {
      clearTimeout(timer)
      timer = setTimeout(refresh, 150)
    }
    void refresh()
    const unsubscribe = subscribeRepositoryReads(repositoryId, (change) => {
      if (hasSourceChanges(change)) refresh()
    })
    window.addEventListener("focus", focus)
    return () => {
      alive = false
      clearTimeout(timer)
      unsubscribe()
      window.removeEventListener("focus", focus)
      // The native session cache owns this context, not the mounted view.
    }
  }, [repositoryId, retry])
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        role="status"
        className="flex min-h-6 shrink-0 items-center gap-2 px-4 py-1 text-xs text-muted-foreground"
      >
        {error ||
          (refreshing
            ? snapshot
              ? "Updating project files…"
              : "Reading project files…"
            : "")}
        {error && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setRetry((n) => n + 1)}
          >
            Retry
          </Button>
        )}
      </div>
      {snapshot && (
        <UnderstandWorkspace snapshot={snapshot} onError={onError} />
      )}
    </div>
  )
}
