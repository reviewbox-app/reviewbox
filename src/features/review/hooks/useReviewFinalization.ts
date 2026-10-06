"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type {
  Review,
  ReviewAction,
  ReviewFinalization,
} from "@/lib/desktop/contracts.generated"
import { desktopAvailable, errorMessage } from "@/lib/desktop/review.commands"
import {
  finalizationRetryAction,
  newestFinalization,
} from "../helpers/reviewFinalization.helpers"
import { reviewFinalizationCommands as commands } from "../services/reviewFinalization.commands"

type State = {
  key: string
  operation: ReviewFinalization | null
  starting: boolean
  error: string
  original: ReviewAction | null
  reconciled: boolean
}

function emptyState(key: string): State {
  return {
    key,
    operation: null,
    starting: false,
    error: "",
    original: null,
    reconciled: false,
  }
}

export function useReviewFinalization(review: Review | undefined) {
  const repositoryId = review?.repositoryId
  const reviewId = review?.id
  const key = repositoryId && reviewId ? `${repositoryId}/${reviewId}` : ""
  const [state, setState] = useState<State>(() => emptyState(key))
  const current = useRef(state)
  const owner = useRef(key)
  const request = useRef(0)
  const retired = useRef(new Set<string>())
  const accept = useCallback((next: State) => {
    current.current = next
    setState(next)
  }, [])
  const receive = useCallback(
    (value: ReviewFinalization) => {
      const identity = `${value.repositoryId}/${value.reviewId}`
      if (owner.current !== identity || retired.current.has(value.id)) return
      const previous = current.current.key === identity ? current.current : null
      const operation = newestFinalization(previous?.operation ?? null, value)
      if (
        operation === previous?.operation &&
        !previous.error &&
        previous.reconciled
      )
        return
      if (previous?.operation && previous.operation.id !== operation.id)
        retired.current.add(previous.operation.id)
      request.current++
      accept({
        key: identity,
        operation,
        starting: false,
        error: "",
        original: previous?.original ?? null,
        reconciled: true,
      })
    },
    [accept]
  )
  const refresh = useCallback(async () => {
    if (!repositoryId || !reviewId || !desktopAvailable()) return
    if (current.current.key === key && current.current.starting) return
    const token = ++request.current
    try {
      const value = await commands.get(repositoryId, reviewId)
      if (owner.current !== key || token !== request.current) return
      if (value) receive(value)
      else
        accept({
          key,
          operation: null,
          starting: false,
          error: "",
          original: null,
          reconciled: true,
        })
    } catch (cause) {
      if (owner.current === key && token === request.current)
        accept({
          ...(current.current.key === key ? current.current : emptyState(key)),
          key,
          error: errorMessage(cause),
          reconciled: true,
        })
    }
  }, [repositoryId, reviewId, key, receive, accept])
  useEffect(() => {
    owner.current = key
    request.current++
    retired.current.clear()
    if (!key || !desktopAvailable()) return
    let disposed = false
    // Subscribe before reconciliation so a fast native completion is not lost.
    const subscription = commands.subscribe((value) => {
      if (!disposed) receive(value)
    })
    void subscription
      .then(() => {
        if (!disposed) void refresh()
      })
      .catch((cause) => {
        if (!disposed)
          accept({
            ...(current.current.key === key
              ? current.current
              : emptyState(key)),
            key,
            error: errorMessage(cause),
            reconciled: true,
          })
      })
    const focus = () => void refresh()
    window.addEventListener("focus", focus)
    return () => {
      disposed = true
      owner.current = ""
      window.removeEventListener("focus", focus)
      void subscription.then((dispose) => dispose()).catch(() => {})
    }
  }, [key, receive, refresh, accept])
  const start = useCallback(
    async (value: Review, action: ReviewAction) => {
      const identity = `${value.repositoryId}/${value.id}`
      if (owner.current !== identity) return false
      if (
        current.current.key === identity &&
        (current.current.starting ||
          current.current.operation?.status === "running")
      )
        return false
      if (current.current.key === identity && current.current.operation)
        retired.current.add(current.current.operation.id)
      request.current++
      accept({
        key: identity,
        operation: null,
        starting: true,
        error: "",
        original: action,
        reconciled: true,
      })
      try {
        const operation = await commands.start(
          value.repositoryId,
          value.id,
          value.revision,
          action
        )
        if (owner.current !== identity) return true
        receive(operation)
        return true
      } catch (cause) {
        if (owner.current === identity) {
          accept({
            ...current.current,
            key: identity,
            starting: false,
            error: errorMessage(cause),
          })
          // The command may have started before its response was lost.
          void refresh()
        }
        return false
      }
    },
    [accept, receive, refresh]
  )
  const isActive = useCallback(
    () =>
      !!owner.current &&
      (current.current.key !== owner.current ||
        !current.current.reconciled ||
        current.current.starting ||
        current.current.operation?.status === "running"),
    []
  )
  const visible = state.key === key ? state : null
  return {
    operation: visible?.operation ?? null,
    starting: visible?.starting ?? false,
    error: visible?.error ?? "",
    checking: !!key && !visible?.reconciled,
    active:
      !!visible &&
      (visible.starting || visible.operation?.status === "running"),
    retryAction: review
      ? finalizationRetryAction(
          review,
          visible?.operation?.action ?? visible?.original
        )
      : null,
    start,
    isActive,
  }
}

export type ReviewFinalizationSession = ReturnType<typeof useReviewFinalization>
