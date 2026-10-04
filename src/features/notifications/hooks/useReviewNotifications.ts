"use client"

import { useEffect } from "react"
import { listen } from "@tauri-apps/api/event"
import type { ReviewNotificationTarget } from "@/lib/desktop/contracts.generated"
import {
  call,
  desktopAvailable,
  errorMessage,
} from "@/lib/desktop/review.commands"
import { connectReviewNotifications } from "../services/reviewNotifications"

export function useReviewNotifications(
  open: (target: ReviewNotificationTarget) => Promise<void>,
  reportError: (message: string) => void
) {
  useEffect(() => {
    if (!desktopAvailable()) return
    return connectReviewNotifications(
      {
        listen: (receive) =>
          listen<ReviewNotificationTarget>(
            "reviewbox:open-review-notification",
            (event) => receive(event.payload)
          ),
        pending: () =>
          call<ReviewNotificationTarget | null>("pending_review_notification"),
        acknowledge: (operationId) =>
          call<void>("acknowledge_review_notification", { operationId }),
      },
      open,
      (error) => reportError(errorMessage(error))
    )
  }, [open, reportError])
}
