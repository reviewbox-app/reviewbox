"use client"
import { useCallback, useEffect, useRef, useState } from "react"
import { listen } from "@tauri-apps/api/event"
import type {
  ProviderSettings,
  ProviderStatus,
} from "@/lib/desktop/contracts.generated"
import { reviewCommands, errorMessage } from "@/lib/desktop/review.commands"
import { agentCommands } from "../services/agent.commands"

/** Refresh across native windows and when returning from a terminal update. */
export function useProviderStatus() {
  const alive = useRef(false)
  const sequence = useRef(0)
  const [status, setStatus] = useState({
    providers: [] as ProviderStatus[],
    settings: null as ProviderSettings | null,
    defaultProvider: "codex",
    checking: true,
    error: "",
  })
  const refresh = useCallback(async () => {
    const current = ++sequence.current
    setStatus((value) => ({ ...value, checking: true }))
    await Promise.all([reviewCommands.providers(), agentCommands.settings()])
      .then(([providers, settings]) => {
        if (alive.current && current === sequence.current)
          setStatus({
            providers,
            settings,
            defaultProvider: settings.defaultProvider,
            checking: false,
            error: "",
          })
      })
      .catch((e) => {
        if (alive.current && current === sequence.current)
          setStatus((value) => ({
            ...value,
            providers: [],
            checking: false,
            error: errorMessage(e),
          }))
      })
  }, [])
  useEffect(() => {
    alive.current = true
    const onRefresh = () => {
      void refresh()
    }
    const unsubscribe = listen("reviewbox:providers-changed", onRefresh).catch(
      () => () => {}
    )
    window.addEventListener("focus", onRefresh)
    onRefresh()
    return () => {
      alive.current = false
      sequence.current += 1
      window.removeEventListener("focus", onRefresh)
      void unsubscribe.then((stop) => stop())
    }
  }, [refresh])
  return { ...status, refresh }
}
