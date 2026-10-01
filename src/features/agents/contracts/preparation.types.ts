import type { PreparationState } from "@/lib/desktop/contracts.generated"
import type { PreparationProgress } from "../helpers/preparationProgress.helpers"

/** Rev writes the review, checks its references and saves it; no acceptance step. */
export type PreparationPhase =
  | "loading"
  | "running"
  | "checking"
  | "applying"
  | "complete"
  | "cancelled"
  | "error"

export type ReviewPreparationView = {
  state: PreparationState | null
  progress: PreparationProgress | null
  active: boolean
  pending: boolean
  error: string
  status: string
  readyToOpen: boolean
  start: () => void | Promise<void>
  cancel: () => void | Promise<void>
}

export type ReviewUpdateView = {
  needsUpdate: boolean
  checking: boolean
  staleStepIds: string[]
  busy: boolean
  onUpdate: () => void
}
