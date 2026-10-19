import { useEffect, useLayoutEffect, useRef, useState } from "react"
import type { FileContent, Workspace } from "@/lib/desktop/contracts.generated"
import { reviewCommands, errorMessage } from "@/lib/desktop/review.commands"
import {
  searchReviewContent,
  type ReviewSearchResult,
} from "../services/reviewContentSearch"
export type { ReviewSearchMatch } from "../services/reviewContentSearch"

/** A query owns cancellation; only immutable sources are cached (at most 8 MB of text). */
export function useReviewContentSearch(
  workspace: Workspace,
  query: string,
  enabled: boolean
) {
  const [retry, setRetry] = useState(0)
  const key = `${workspace.snapshot.id}/${query}`
  const [state, setState] = useState<{
    key: string
    result?: ReviewSearchResult
    pending: boolean
    error?: string
  }>()
  const snapshotRef = useRef(workspace.snapshot)
  const cache = useRef({
    snapshot: "",
    chars: 0,
    files: new Map<string, FileContent>(),
  })
  useLayoutEffect(() => {
    snapshotRef.current = workspace.snapshot
  }, [workspace.snapshot])
  useEffect(() => {
    if (!enabled || !query.trim()) return
    const snapshot = snapshotRef.current
    const controller = new AbortController()
    if (cache.current.snapshot !== snapshot.id)
      cache.current = { snapshot: snapshot.id, chars: 0, files: new Map() }
    const sources = cache.current
    const read = async (changeId: string) => {
      const cached = sources.files.get(changeId)
      if (cached) return cached
      const value = await reviewCommands.content(snapshot.id, changeId)
      const size = (value.before?.length ?? 0) + (value.after?.length ?? 0)
      if (sources.chars + size <= 4_000_000) {
        sources.chars += size
        sources.files.set(changeId, value)
      }
      return value
    }
    const run = async () => {
      setState((old) => ({
        key,
        result: old?.key === key ? old.result : undefined,
        pending: true,
      }))
      try {
        const result = await searchReviewContent(
          snapshot.changes,
          query,
          key,
          controller.signal,
          read,
          (result) => {
            if (!controller.signal.aborted)
              setState({ key, result, pending: true })
          }
        )
        if (!controller.signal.aborted)
          setState({ key, result, pending: false })
      } catch (error) {
        if (!controller.signal.aborted)
          setState((old) => ({
            key,
            result: old?.key === key ? old.result : undefined,
            pending: false,
            error: errorMessage(error),
          }))
      }
    }
    const timer = setTimeout(() => void run(), 200)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [key, query, enabled, retry])
  const current = enabled && state?.key === key ? state : undefined
  return {
    result: current?.result,
    pending: enabled && (current?.pending ?? true),
    error: current?.error,
    refresh: () => setRetry((r) => r + 1),
  }
}
