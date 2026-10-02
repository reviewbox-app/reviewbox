import { call as invoke } from "@/lib/desktop/review.commands"
import type {
  ProviderSettings,
  ProviderModel,
} from "@/lib/desktop/contracts.generated"
export const agentCommands = {
  models: (id: string, provider: string) =>
    invoke<ProviderModel[]>("provider_models", { id, provider }),
  cancelModels: (id: string) => invoke<void>("cancel_provider_models", { id }),
  settings: () => invoke<ProviderSettings>("provider_settings"),
  configure: (settings: ProviderSettings) =>
    invoke<ProviderSettings>("configure_providers", { settings }),
}
