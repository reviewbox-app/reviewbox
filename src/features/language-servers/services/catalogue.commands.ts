import { call } from "@/lib/desktop/review.commands"
import type {
  LanguageServerCatalogue,
  LanguageServerInstallOperation,
} from "@/lib/desktop/contracts.generated"

export const catalogueCommands = {
  read: () => call<LanguageServerCatalogue>("get_language_server_catalogue"),
  install: (serverId: string) =>
    call<LanguageServerInstallOperation>("install_language_server", {
      serverId,
    }),
  cancel: (operationId: string) =>
    call<void>("cancel_language_server_install", { operationId }),
  enable: (serverId: string, enabled: boolean) =>
    call<void>("set_language_server_enabled", { serverId, enabled }),
  uninstall: (serverId: string) =>
    call<void>("uninstall_language_server", { serverId }),
  paths: (repositoryId: string) =>
    call<string[]>("language_repository_paths", { repositoryId }),
}
