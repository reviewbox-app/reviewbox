"use client"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import type {
  EditorEntry,
  RepositoryReadChange,
} from "@/lib/desktop/contracts.generated"
import { subscribeRepositoryReads } from "@/lib/desktop/repositoryReads"
import { errorMessage } from "@/lib/desktop/review.commands"
import { editorCommands } from "../services/editor.commands"

/** Read-only explorer consumer; opening it never creates editable buffers. */
export function useEditorInventory(
  repositoryId: string | undefined,
  expanded: string[],
  enabled: boolean
) {
  const [state, setState] = useState<{
    repositoryId: string
    entries: EditorEntry[]
    error: string
  }>({ repositoryId: "", entries: [], error: "" })
  const expandedRef = useRef(expanded)
  useLayoutEffect(() => {
    expandedRef.current = expanded
  }, [expanded])
  const expansion = JSON.stringify(expanded)
  useEffect(() => {
    if (!repositoryId || !enabled) return
    let active = true
    let token = 0
    const read = async (change?: RepositoryReadChange) => {
      const request = ++token
      try {
        const entries = await editorCommands.inventory(
          repositoryId,
          true,
          expandedRef.current,
          change
        )
        if (active && request === token)
          setState({ repositoryId, entries, error: "" })
      } catch (error) {
        if (active && request === token)
          setState((s) => ({ ...s, repositoryId, error: errorMessage(error) }))
      }
    }
    void read()
    const stop = subscribeRepositoryReads(
      repositoryId,
      (change) => {
        if (change.tree || change.full) void read(change)
      },
      () => void read()
    )
    return () => {
      active = false
      stop()
    }
  }, [repositoryId, enabled, expansion])
  return state.repositoryId === repositoryId
    ? state
    : { entries: [], error: "" }
}
