import { call } from "@/lib/desktop/review.commands"
import type {
  LanguageDocument,
  LanguageRequest,
  LanguageResponse,
} from "@/lib/desktop/contracts.generated"

export const languageSessionCommands = {
  request: (request: LanguageRequest) =>
    call<LanguageResponse>("language_request", { request }),
  cancel: (requestId: string) =>
    call<void>("cancel_language_request", { requestId }),
  source: (document: LanguageDocument) =>
    call<string>("read_language_source", { document }),
  release: (snapshotId: string) =>
    call<void>("release_language_snapshot", { snapshotId }),
}
