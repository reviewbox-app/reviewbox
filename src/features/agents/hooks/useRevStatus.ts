"use client"
import { useEffect, useState } from "react"
import type { ProviderStatus } from "@/lib/desktop/contracts.generated"
import { reviewCommands } from "@/lib/desktop/review.commands"
import { agentCommands } from "../services/agent.commands"

export const harnessNames: Record<string, string> = {
  codex: "Codex",
  claude: "Claude Code",
}

export interface RevStatus {
  /** Harness Rev currently runs on, or null while unknown. */
  harness: ProviderStatus | null
  state: "checking" | "ready" | "unavailable"
}

/** Reads which harness backs Rev and whether it is installed. Never starts a session. */
export function useRevStatus(): RevStatus {
  const [status, setStatus] = useState<RevStatus>({
    harness: null,
    state: "checking",
  })
  useEffect(() => {
    // Outside the desktop app the commands reject, which reports "unavailable".
    let alive = true
    Promise.all([reviewCommands.providers(), agentCommands.settings()])
      .then(([providers, settings]) => {
        if (!alive) return
        const harness =
          providers.find((p) => p.provider === settings.defaultProvider) ??
          providers[0] ??
          null
        setStatus({
          harness,
          state: harness?.available ? "ready" : "unavailable",
        })
      })
      .catch(() => {
        if (alive) setStatus({ harness: null, state: "unavailable" })
      })
    return () => {
      alive = false
    }
  }, [])
  return status
}
