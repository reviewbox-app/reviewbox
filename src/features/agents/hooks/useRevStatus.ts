"use client"
import type { ProviderStatus } from "@/lib/desktop/contracts.generated"
import { useProviderStatus } from "./useProviderStatus"

export const harnessNames: Record<string, string> = {
  codex: "Codex",
  claude: "Claude Code",
}
export interface RevStatus {
  harness: ProviderStatus | null
  state:
    | "checking"
    | "ready"
    | "unavailable"
    | "update required"
    | "version unknown"
    | "sign in required"
    | "verification failed"
}
export function useRevStatus(): RevStatus {
  const { providers, defaultProvider, checking } = useProviderStatus()
  const configured = providers.find((p) => p.provider === defaultProvider)
  const harness =
    (configured?.ready ? configured : providers.find((p) => p.ready)) ??
    configured ??
    null
  return {
    harness,
    state: checking
      ? "checking"
      : harness?.ready
        ? "ready"
        : harness?.compatibility === "outdated"
          ? "update required"
          : harness?.compatibility === "unknown"
            ? "version unknown"
            : !harness?.available
              ? "unavailable"
              : harness.authentication === "signedOut"
                ? "sign in required"
                : "verification failed",
  }
}
