"use client"
import { useCallback, useEffect, useRef, useState } from "react"
import type { ReviewCommitOperation } from "@/lib/desktop/contracts.generated"
import { desktopAvailable, errorMessage } from "@/lib/desktop/review.commands"
import { reviewCommitCommands } from "../services/reviewCommit.commands"
import {
  sourceControlCommands,
  waitForGitRefresh,
} from "../services/source-control.commands"

export function useReviewCommit(repositoryId: string, reviewId: string) {
  const [state, setState] = useState<ReviewCommitOperation | null>(null)
  const [error, setError] = useState("")
  const [starting, setStarting] = useState(false)
  const current = useRef(`${repositoryId}:${reviewId}`)
  const busy = useRef(false)
  const identity = `${repositoryId}:${reviewId}`
  useEffect(() => {
    current.current = identity
    let alive = true
    let unlisten: (() => void) | undefined
    const accept = (value: ReviewCommitOperation | null) => {
      if (
        !alive ||
        !value ||
        value.reviewId !== reviewId ||
        value.operation.repositoryId !== repositoryId
      )
        return
      setState((old) =>
        old?.reviewId === value.reviewId && old.sequence > value.sequence
          ? old
          : value
      )
    }
    const refresh = () =>
      reviewCommitCommands
        .get(repositoryId, reviewId)
        .then(accept)
        .catch((e) => {
          if (alive) setError(errorMessage(e))
        })
    if (desktopAvailable()) {
      void reviewCommitCommands
        .subscribe(accept)
        .then((off) => {
          if (!alive) {
            off()
            return
          }
          unlisten = off
          void refresh()
        })
        .catch((e) => {
          if (alive) setError(errorMessage(e))
        })
      window.addEventListener("focus", refresh)
    }
    return () => {
      alive = false
      current.current = ""
      unlisten?.()
      window.removeEventListener("focus", refresh)
    }
  }, [identity, repositoryId, reviewId])
  const start = useCallback(async () => {
    if (busy.current) return
    busy.current = true
    setStarting(true)
    setError("")
    try {
      await waitForGitRefresh(repositoryId)
      if (current.current !== identity) return
      const next = await reviewCommitCommands.start(repositoryId, reviewId)
      if (current.current === identity)
        setState((old) =>
          old?.reviewId === next.reviewId && old.sequence > next.sequence
            ? old
            : next
        )
    } catch (e) {
      if (current.current === identity) setError(errorMessage(e))
    } finally {
      busy.current = false
      if (current.current === identity) setStarting(false)
    }
  }, [identity, repositoryId, reviewId])
  const stop = async () => {
    if (!state) return
    try {
      await sourceControlCommands.cancel(state.operation.id)
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  return {
    state:
      state?.operation.status !== "dismissed" &&
      state?.reviewId === reviewId &&
      state.operation.repositoryId === repositoryId
        ? state
        : null,
    error,
    start,
    stop,
    starting,
    clearError: () => setError(""),
  }
}
