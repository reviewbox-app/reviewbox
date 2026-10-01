"use client"

import { useEffect, useState } from "react"
import type {
  DocumentDiff,
  DocumentDiffRequest,
  DocumentDiffResponse,
} from "../contracts/documentDiff.types"

export function useDocumentDiff(before: string | null, after: string | null) {
  const [state, setState] = useState<{
    before: string | null
    after: string | null
    result?: DocumentDiff
    error?: string
  } | null>(null)
  useEffect(() => {
    let active = true
    let worker: Worker | undefined
    try {
      worker = new Worker("/monaco/document-diff.worker.js", { type: "module" })
      worker.onmessage = ({ data }: MessageEvent<DocumentDiffResponse>) => {
        if (active) setState({ before, after, ...data })
        worker?.terminate()
      }
      worker.onerror = () => {
        if (active)
          setState({
            before,
            after,
            error: "The Markdown preview could not be loaded.",
          })
        worker?.terminate()
      }
      worker.postMessage({ before, after } satisfies DocumentDiffRequest)
    } catch {
      queueMicrotask(() => {
        if (active)
          setState({
            before,
            after,
            error: "The Markdown preview could not be loaded.",
          })
      })
    }
    return () => {
      active = false
      // Termination cancels the computation itself, not just its eventual result.
      worker?.terminate()
    }
  }, [before, after])
  return state?.before === before && state.after === after ? state : null
}
