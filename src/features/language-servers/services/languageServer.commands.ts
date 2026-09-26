import { call as invoke } from "@/lib/desktop/review.commands"
import type {
  CodeLocation,
  LanguageServerSettings,
} from "@/lib/desktop/contracts.generated"
export const languageServerCommands = {
  settings: () => invoke<LanguageServerSettings>("language_server_settings"),
  configure: (settings: LanguageServerSettings) =>
    invoke<LanguageServerSettings>("configure_language_servers", { settings }),
  definition: (
    snapshotId: string,
    path: string,
    line: number,
    column: number
  ) =>
    invoke<CodeLocation[]>("find_definition", {
      snapshotId,
      path,
      line,
      column,
    }),
}
