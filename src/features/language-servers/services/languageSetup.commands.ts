import { Channel } from "@tauri-apps/api/core"
import { call } from "@/lib/desktop/review.commands"
import type {
  AgentEvent,
  LanguageSetupPlan,
  LanguageSetupStatus,
} from "@/lib/desktop/contracts.generated"
export const languageSetupCommands = {
  plan: (
    repositoryId: string,
    path: string,
    operationId: string,
    diagnostic: string,
    onEvent: (event: AgentEvent) => void
  ) => {
    const channel = new Channel<AgentEvent>()
    channel.onmessage = onEvent
    return call<LanguageSetupPlan>("plan_language_setup", {
      request: { repositoryId, path, operationId, diagnostic },
      channel,
    })
  },
  latest: (repositoryId: string, path: string) =>
    call<LanguageSetupStatus | null>("latest_language_setup", {
      repositoryId,
      path,
    }),
  apply: (planId: string) =>
    call<LanguageSetupStatus>("apply_language_setup", { planId }),
  status: (planId: string) =>
    call<LanguageSetupStatus>("get_language_setup", { planId }),
  cancel: (operationId: string) =>
    call<void>("cancel_language_setup", { operationId }),
}
