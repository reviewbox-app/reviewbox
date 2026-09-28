/** Rev writes the review, checks its references and saves it; no acceptance step. */
export type PreparationPhase =
  | "loading"
  | "running"
  | "checking"
  | "applying"
  | "complete"
  | "cancelled"
  | "error"
