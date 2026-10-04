"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { ReviewPreparationContent } from "@/features/agents/components/ReviewPreparationContent"
import type { ReviewPreparationView } from "@/features/agents/contracts/preparation.types"
import { SettingsDialog } from "@/features/settings/composites/SettingsDialog"
import type { Workspace } from "@/lib/desktop/contracts.generated"

const action = () => {}
const error = {
  code: "provider_authentication",
  message:
    "Codex could not complete the request. Completed preparation results are kept.",
  details:
    "HTTP 403: session expired. Authorization: Bearer fixture-private-token",
  retryable: false,
}
const workspace = {
  review: {
    id: "fixture-review",
    repositoryId: "fixture-checkout",
    title: "Error reporting fixture",
  },
  snapshot: { id: "fixture-snapshot", changes: [] },
} as unknown as Workspace
const preparation: ReviewPreparationView = {
  state: {
    id: "fixture-operation",
    reviewId: "fixture-review",
    snapshotId: "fixture-snapshot",
    provider: "codex",
    status: "failed",
    phase: "documents",
    activeBatches: [],
    completedBatches: 1,
    totalBatches: 2,
    steps: [],
    phases: [],
    events: [],
    error,
    startedAt: "1",
    updatedAt: "2",
    canResume: true,
  },
  progress: null,
  active: false,
  pending: false,
  error: error.message,
  status: "",
  readyToOpen: false,
  start: action,
  cancel: action,
}

/** Development-only page: exercises the shipped components with a failed run. */
export function DiagnosticsWorkbench() {
  const [settings, setSettings] = useState(false)
  return (
    <main className="min-h-screen p-4">
      <Button variant="ghost" onClick={() => setSettings(true)}>
        Settings
      </Button>
      <ReviewPreparationContent
        workspace={workspace}
        preparation={preparation}
        onStart={action}
        onLeave={action}
      />
      <SettingsDialog open={settings} onClose={() => setSettings(false)} />
    </main>
  )
}
