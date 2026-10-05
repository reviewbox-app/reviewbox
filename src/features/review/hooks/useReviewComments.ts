"use client"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import type {
  ReviewCommentMutation,
  ReviewCommentsDocument,
  Review,
} from "@/lib/desktop/contracts.generated"
import { desktopAvailable, errorMessage } from "@/lib/desktop/review.commands"
import { subscribeRepositoryReads } from "@/lib/desktop/repositoryReads"
import { reviewCommentsCommands } from "../services/reviewComments.commands"

export function useReviewComments(review: Review) {
  const repositoryId = review.repositoryId
  const reviewId = review.id
  const key = `${repositoryId}/${reviewId}`
  const enabled = review.mode === "manual"
  const [state, setState] = useState<{
    key: string
    document?: ReviewCommentsDocument
    error?: string
    busy?: boolean
  }>({ key })
  const current = useRef(state)
  const request = useRef(0)
  const writing = useRef<string | null>(null)
  const identity = useRef(key)
  useLayoutEffect(() => {
    identity.current = key
    return () => {
      identity.current = ""
    }
  }, [key])
  const invalidate = useCallback(() => {
    request.current++
  }, [])
  const accept = useCallback((value: typeof state) => {
    if (identity.current !== value.key) return
    current.current = value
    setState(value)
  }, [])
  const reload = useCallback(
    async (keepError = false) => {
      if (!enabled || !desktopAvailable() || writing.current === key) return
      const token = ++request.current
      try {
        const document = await reviewCommentsCommands.read(
          repositoryId,
          reviewId
        )
        if (token === request.current)
          accept({
            key,
            document,
            error: keepError ? current.current.error : undefined,
          })
      } catch (cause) {
        if (token === request.current)
          accept({
            key,
            document:
              current.current.key === key
                ? current.current.document
                : undefined,
            error: errorMessage(cause),
          })
      }
    },
    [enabled, repositoryId, reviewId, key, accept]
  )
  useEffect(() => {
    void reload()
    const focus = () => {
      if (document.visibilityState !== "hidden") void reload()
    }
    const stop = enabled
      ? subscribeRepositoryReads(repositoryId, (change) => {
          if (
            change.full ||
            change.paths.some(
              (path) =>
                path === ".reviewbox/.local/REVIEW_COMMENTS.md" ||
                path === ".reviewbox/REVIEW_COMMENTS.md"
            )
          )
            void reload()
        })
      : () => {}
    window.addEventListener("focus", focus)
    document.addEventListener("visibilitychange", focus)
    return () => {
      invalidate()
      stop()
      window.removeEventListener("focus", focus)
      document.removeEventListener("visibilitychange", focus)
    }
  }, [reload, enabled, repositoryId, invalidate])
  const mutate = useCallback(
    async (mutation: ReviewCommentMutation) => {
      const document =
        current.current.key === key ? current.current.document : undefined
      if (!document || writing.current === key) return false
      writing.current = key
      request.current++
      accept({ key, document, busy: true })
      try {
        const result = await reviewCommentsCommands.mutate(
          repositoryId,
          reviewId,
          document.revision,
          mutation
        )
        accept({ key, document: result })
        return identity.current === key
      } catch (cause) {
        if (identity.current !== key) return false
        accept({ key, document, error: errorMessage(cause) })
        writing.current = null
        await reload(true)
        return false
      } finally {
        if (writing.current === key) writing.current = null
      }
    },
    [key, repositoryId, reviewId, accept, reload]
  )
  return {
    document: state.key === key ? state.document : undefined,
    error: state.key === key ? state.error : undefined,
    busy: state.key === key && !!state.busy,
    editable: enabled && review.publication.status === "draft",
    reload,
    mutate,
  }
}
export type ReviewCommentsSession = ReturnType<typeof useReviewComments>
