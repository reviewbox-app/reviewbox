import type {
  ProposalDiagnostic,
  Topic,
} from "@/lib/desktop/contracts.generated"

export type TopicChoice = "pending" | "accepted" | "rejected"
export type PreparedTopic = {
  topic: Topic
  choice: TopicChoice
  diagnostics: ProposalDiagnostic[]
}
export type PreparationPhase =
  | "loading"
  | "ready"
  | "running"
  | "checking"
  | "suggestions"
  | "cancelled"
  | "error"
  | "applying"
  | "complete"
