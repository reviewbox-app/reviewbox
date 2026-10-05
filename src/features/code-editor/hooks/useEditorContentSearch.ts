"use client"
import { useEffect, useRef, useState } from "react"
import type { EditorSearchResult } from "@/lib/desktop/contracts.generated"
import { subscribeRepositoryReads } from "@/lib/desktop/repositoryReads"
import {
  createEditorSearch,
  searchablePaths,
  searchRefreshPaths,
  type EditorSearchSnapshot,
} from "../services/editorSearch.service"
import { dirty, getEditor, useEditorStore } from "../stores/editor.store"

/** One operation owner; batches, file changes and buffers share its query generation. */
export function useEditorContentSearch(
  repositoryId: string,
  query: string,
  enabled: boolean
) {
  const [generation, setGeneration] = useState(0)
  const key = JSON.stringify([repositoryId, query])
  const cache = useRef<{ key: string; result?: EditorSearchResult }>({
    key: "",
  })
  const [state, setState] = useState<EditorSearchSnapshot & { key: string }>()
  useEffect(() => {
    if (!enabled || !query) return
    const operation = createEditorSearch({
      repositoryId,
      query,
      owner: crypto.randomUUID(),
      initial: cache.current.key === key ? cache.current.result : undefined,
      buffers: () =>
        (getEditor(repositoryId)?.buffers ?? [])
          .filter((buffer) => dirty(buffer) && !buffer.path.startsWith("file:"))
          .map(({ path, version, text }) => ({ path, version, text })),
      publish: (snapshot) => {
        cache.current = { key, result: snapshot.result }
        setState({ key, ...snapshot })
      },
    })
    const enqueue = operation.refresh
    const stopFiles = subscribeRepositoryReads(repositoryId, (change) => {
      const paths = searchRefreshPaths(
        change,
        getEditor(repositoryId)?.entries ?? []
      )
      if (!paths || paths.length) enqueue(paths)
    })
    let previous = getEditor(repositoryId)?.buffers
    const stopBuffers = useEditorStore.subscribe(() => {
      const buffers = getEditor(repositoryId)?.buffers
      if (buffers === previous) return
      const old = new Map(
        (previous ?? [])
          .filter(dirty)
          .map((buffer) => [buffer.path, buffer.text])
      )
      const next = new Map(
        (buffers ?? [])
          .filter(dirty)
          .map((buffer) => [buffer.path, buffer.text])
      )
      previous = buffers
      const changed = searchablePaths(
        [...new Set([...old.keys(), ...next.keys()])].filter(
          (path) =>
            old.get(path) !== next.get(path) && !path.startsWith("file:")
        ),
        getEditor(repositoryId)?.entries ?? []
      )
      if (changed.length) enqueue(changed)
    })
    enqueue()
    return () => {
      operation.dispose()
      stopFiles()
      stopBuffers()
    }
  }, [repositoryId, query, enabled, key, generation])
  const current = enabled && state?.key === key ? state : undefined
  return {
    refresh: () => setGeneration((value) => value + 1),
    result: current?.result,
    error: current?.error,
    pending: enabled && !!query && (current?.pending ?? true),
  }
}
