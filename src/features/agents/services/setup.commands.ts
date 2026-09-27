import { Channel } from "@tauri-apps/api/core"
import { call } from "@/lib/desktop/review.commands"
import type {
  ProviderSetupEvent,
  ProviderStatus,
} from "@/lib/desktop/contracts.generated"

export const setupCommands = {
  chooseExecutable: () => call<string | null>("choose_provider_executable"),
  install(
    provider: string,
    operationId: string,
    onEvent: (event: ProviderSetupEvent) => void
  ) {
    const channel = new Channel<ProviderSetupEvent>()
    channel.onmessage = onEvent
    return call<ProviderStatus>("install_provider", {
      request: { provider, operationId },
      channel,
    })
  },
  cancel: (operationId: string) =>
    call<void>("cancel_provider_setup", { operationId }),
  login: (provider: string) => call<void>("open_provider_login", { provider }),
}
