"use client"
import { useEffect, useEffectEvent } from "react"
import { listen } from "@tauri-apps/api/event"
import { call, desktopAvailable } from "@/lib/desktop/review.commands"

export function useRepositoryGitMenu(
  repositoryId: string | undefined,
  onLocal: () => void
) {
  const receive = useEffectEvent((id: string) => {
    if (id === repositoryId && !document.querySelector('[role="dialog"]'))
      onLocal()
  })
  useEffect(() => {
    if (!desktopAvailable()) return
    let disposed = false
    const subscription = listen<string>(
      "reviewbox:view-local-changes",
      ({ payload }) => {
        if (!disposed) receive(payload)
      }
    )
    void call("configure_repository_menu", {
      repositoryId: repositoryId ?? null,
    }).catch(() => {})
    return () => {
      disposed = true
      void subscription.then((stop) => stop()).catch(() => {})
    }
  }, [repositoryId])
}
