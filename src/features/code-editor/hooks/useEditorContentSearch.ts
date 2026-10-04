"use client"
import { useEffect, useState } from "react"
import type { EditorSearchResult } from "@/lib/desktop/contracts.generated"
import { errorMessage } from "@/lib/desktop/review.commands"
import { editorCommands } from "../services/editor.commands"

export function useEditorContentSearch(
  repositoryId: string,
  query: string,
  enabled: boolean
) {
  const [generation, setGeneration] = useState(0)
  // Inventory polling must not cancel/restart a search or discard its results.
  const key = JSON.stringify([repositoryId, query, generation])
  const [state, setState] = useState<{
    key: string
    result?: EditorSearchResult
    error?: string
  }>()
  useEffect(() => {
    if (!enabled || !query) return
    let disposed = false
    let started = false
    const requestId = crypto.randomUUID()
    const timer = setTimeout(() => {
      started = true
      void editorCommands
        .search(repositoryId, query, requestId)
        .then((result) => {
          if (!disposed) setState({ key, result })
        })
        .catch((error) => {
          if (!disposed) setState({ key, error: errorMessage(error) })
        })
    }, 200)
    return () => {
      disposed = true
      clearTimeout(timer)
      if (started) void editorCommands.cancelSearch(requestId).catch(() => {})
    }
  }, [repositoryId, query, enabled, key])
  const current = enabled && state?.key === key ? state : undefined
  return {
    refresh: () => setGeneration((value) => value + 1),
    result: current?.result,
    error: current?.error,
    pending: enabled && !!query && !current,
  }
}
