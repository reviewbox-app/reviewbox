"use client"
import { useEffect, useRef, useState } from "react"
import type { Snapshot } from "@/lib/desktop/contracts.generated"
import { call, errorMessage } from "@/lib/desktop/review.commands"
import { UnderstandWorkspace } from "./UnderstandWorkspace"

/** Current repository sources, independent of the selected review. */
export function CodeExplainWorkspace({
  repositoryId,
  onError,
}: {
  repositoryId: string
  onError: (error: string) => void
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const current = useRef<string | null>(null)
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const release = (contextId: string) =>
      call<void>("release_code_context", { repositoryId, contextId }).catch(
        () => {}
      )
    const refresh = async () => {
      try {
        const value = await call<Snapshot>("code_explain_context", {
          repositoryId,
          current: current.current,
        })
        if (!alive) {
          if (value.id !== current.current) await release(value.id)
          return
        }
        if (value.id !== current.current) {
          const previous = current.current
          current.current = value.id
          setSnapshot(value)
          if (previous) await release(previous)
        }
      } catch (cause) {
        if (alive) onError(errorMessage(cause))
      } finally {
        if (alive) timer = setTimeout(refresh, 5000)
      }
    }
    void refresh()
    return () => {
      alive = false
      clearTimeout(timer)
      if (current.current) void release(current.current)
      current.current = null
    }
  }, [repositoryId, onError])
  if (!snapshot)
    return (
      <p role="status" className="m-auto text-sm text-muted-foreground">
        Reading project files…
      </p>
    )
  return <UnderstandWorkspace snapshot={snapshot} onError={onError} />
}
