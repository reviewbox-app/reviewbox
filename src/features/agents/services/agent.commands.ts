import { Channel } from "@tauri-apps/api/core"
import { call as invoke } from "@/lib/desktop/review.commands"
import type {
  AgentEvent,
  AgentPreparationContext,
  ProposalDiagnostic,
  AgentRequest,
  AgentRun,
  ProviderSettings,
  ProviderModel,
  Proposal,
  ProposalContent,
} from "@/lib/desktop/contracts.generated"
export const agentCommands = {
  models: (id: string, provider: string) =>
    invoke<ProviderModel[]>("provider_models", { id, provider }),
  cancelModels: (id: string) => invoke<void>("cancel_provider_models", { id }),
  preparationContext: (reviewId: string) =>
    invoke<AgentPreparationContext>("agent_preparation_context", { reviewId }),
  diagnose: (reviewId: string, content: ProposalContent) =>
    invoke<ProposalDiagnostic[]>("diagnose_proposal", { reviewId, content }),
  settings: () => invoke<ProviderSettings>("provider_settings"),
  configure: (settings: ProviderSettings) =>
    invoke<ProviderSettings>("configure_providers", { settings }),
  start(request: AgentRequest, onEvent: (event: AgentEvent) => void) {
    const channel = new Channel<AgentEvent>()
    channel.onmessage = onEvent
    return invoke<AgentRun>("start_agent", { request, channel })
  },
  cancel(id: string) {
    return invoke<void>("cancel_agent", { id })
  },
  proposal(runId: string) {
    return invoke<Proposal>("proposal_from_run", { runId })
  },
  proposals(reviewId: string) {
    return invoke<Proposal[]>("list_proposals", { reviewId })
  },
  answer(
    id: string,
    revision: number,
    content: ProposalContent,
    accepted: boolean
  ) {
    return invoke<Proposal>("answer_proposal", {
      id,
      revision,
      content,
      accepted,
    })
  },
  history(reviewId: string) {
    return invoke<AgentRun[]>("list_agent_runs", { reviewId })
  },
}
