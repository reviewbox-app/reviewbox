"use client"
import { useEffect } from "react"
import type { Workspace } from "@/lib/desktop/contracts.generated"
import { ReviewPreparationContent } from "../components/ReviewPreparationContent"
import type { ReviewPreparationView } from "../contracts/preparation.types"

export function PreparingReview({
  workspace,
  preparation,
  onStart,
  onLeave,
}: {
  workspace: Workspace
  preparation: ReviewPreparationView
  onStart: () => void
  onLeave: () => void
}) {
  const { active, cancel, readyToOpen } = preparation
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        document.querySelector(
          '[role="dialog"], [role="alertdialog"], [role="menu"]'
        )
      )
        return
      if (event.key === "Escape" && active) {
        event.preventDefault()
        void cancel()
      } else if (event.key === "Enter" && readyToOpen && !event.metaKey) {
        event.preventDefault()
        onStart()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [active, cancel, readyToOpen, onStart])
  return (
    <main
      className="relative mx-2 mb-2 flex min-h-0 flex-1 overflow-hidden rounded-panel border bg-card"
      data-testid="preparing-review"
      aria-label="Review preparation"
    >
      <div className="absolute inset-0 overflow-y-auto">
        <ReviewPreparationContent
          workspace={workspace}
          preparation={preparation}
          onStart={onStart}
          onLeave={onLeave}
        />
      </div>
    </main>
  )
}
