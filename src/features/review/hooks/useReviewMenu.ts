"use client"

import { useEffect, useEffectEvent, useMemo, useState } from "react"
import { listen } from "@tauri-apps/api/event"
import type {
  Review,
  ReviewAction,
  ReviewMenuAction,
  ReviewMenuEvent,
  ReviewMenuState,
} from "@/lib/desktop/contracts.generated"
import {
  call,
  desktopAvailable,
  errorMessage,
} from "@/lib/desktop/review.commands"
import {
  canCompleteManually,
  canKeepReviewLocal,
  reviewIsComplete,
} from "../helpers/publication.helpers"

// Serialize presentation updates and unmount cleanup across reader replacements.
let writes: Promise<void> = Promise.resolve()
function configure(context: ReviewMenuState | null) {
  writes = writes
    .catch(() => {})
    .then(() => call("configure_review_menu", { context }))
  return writes
}

export function useReviewMenu({
  review,
  snapshotId,
  hasDocuments,
  busy,
  updatePending,
  enabled = true,
  onRefresh,
  onLocalChanges,
  onAction,
  onDetails,
  onSummary,
}: {
  review: Review
  snapshotId: string
  hasDocuments: boolean
  busy: boolean
  updatePending: boolean
  enabled?: boolean
  onRefresh?: () => void
  onLocalChanges?: () => void
  onAction: (action: ReviewAction) => Promise<boolean>
  onDetails: () => void
  onSummary: () => void
}) {
  const [error, setError] = useState("")
  const manual = canCompleteManually(review)
  const keepable = canKeepReviewLocal(review)
  const complete = reviewIsComplete(review)
  const status = review.publication.status
  const keepLocal = review.publication.keepLocal
  const updateWithRev = !!review.preparationId || review.mode === "guided"
  const needsConfirmation = review.needsUpdateConfirmation
  const canRefresh = !!onRefresh
  const context = useMemo<ReviewMenuState | null>(() => {
    if (!enabled) return null
    const entries: ReviewMenuState["entries"] = []
    const add = (action: ReviewMenuAction, allowed = !busy) =>
      entries.push({ action, enabled: allowed })
    if (onLocalChanges) add("viewLocalChanges", true)
    if (canRefresh) add("refresh", !busy && !updatePending)
    if (needsConfirmation) add("completeUpdated")
    if (manual) add("completeManual")
    if (keepable) add("keepLocal")
    if (status === "publicationPending") add("retryPublication")
    if (complete) add("reopen")
    add("details", true)
    if (hasDocuments || review.mode === "manual") add("summary", true)
    return {
      reviewId: review.id,
      snapshotId,
      status,
      updateWithRev,
      keepLocal,
      entries,
    }
  }, [
    enabled,
    busy,
    updatePending,
    canRefresh,
    onLocalChanges,
    needsConfirmation,
    manual,
    keepable,
    status,
    complete,
    hasDocuments,
    review.mode,
    review.id,
    snapshotId,
    updateWithRev,
    keepLocal,
  ])

  const receive = useEffectEvent((event: ReviewMenuEvent) => {
    if (
      event.reviewId !== review.id ||
      event.snapshotId !== snapshotId ||
      !context?.entries.some(
        (entry) => entry.action === event.action && entry.enabled
      ) ||
      document.querySelector('[role="dialog"], [role="alertdialog"]')
    )
      return
    switch (event.action) {
      case "viewLocalChanges":
        onLocalChanges?.()
        break
      case "refresh":
        onRefresh?.()
        break
      case "details":
        onDetails()
        break
      case "summary":
        onSummary()
        break
      case "completeManual":
        void onAction({ kind: "completeManualReview" })
        break
      case "completeUpdated":
        void onAction({ kind: "completeUpdatedReview" })
        break
      case "keepLocal":
        void onAction({ kind: "setKeepLocal", keepLocal: !keepLocal })
        break
      case "retryPublication":
        void onAction({ kind: "retryPublication" })
        break
      case "reopen":
        void onAction({ kind: "reopenReview" })
        break
    }
  })
  useEffect(() => {
    if (!desktopAvailable()) return
    let disposed = false
    const subscription = listen<ReviewMenuEvent>(
      "reviewbox:review-menu",
      ({ payload }) => {
        if (!disposed) receive(payload)
      }
    )
    void subscription.catch((cause) => {
      if (!disposed) setError(errorMessage(cause))
    })
    return () => {
      disposed = true
      void subscription.then((dispose) => dispose()).catch(() => {})
      void configure(null).catch(() => {})
    }
  }, [])
  useEffect(() => {
    if (!desktopAvailable()) return
    let disposed = false
    void configure(context).catch((cause) => {
      if (!disposed) setError(errorMessage(cause))
    })
    return () => {
      disposed = true
    }
  }, [context])
  return error
}
