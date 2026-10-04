import { call } from "@/lib/desktop/review.commands"
import type {
  EditorFile,
  LiveLanguageDocument,
  LiveLanguageSession,
} from "@/lib/desktop/contracts.generated"
export const liveCommands = {
  open: (
    repositoryId: string,
    path: string,
    languageId: string,
    serverId?: string
  ) =>
    call<LiveLanguageSession>("live_language_open", {
      repositoryId,
      path,
      languageId,
      serverId: serverId ?? null,
    }),
  sync: (sessionId: string, document: LiveLanguageDocument, saved: boolean) =>
    call<void>("live_language_sync", { sessionId, document, saved }),
  request: <T>(
    sessionId: string,
    requestId: string,
    path: string,
    version: number,
    method: string,
    params: object
  ) =>
    call<T>("live_language_request", {
      sessionId,
      requestId,
      path,
      version,
      method,
      params,
    }),
  close: (sessionId: string, path: string) =>
    call<void>("live_language_close", { sessionId, path }),
  cancel: (sessionId: string, requestId: string) =>
    call<void>("live_language_cancel", { sessionId, requestId }),
  restart: (sessionId: string) =>
    call<void>("live_language_restart", { sessionId }),
  source: (sessionId: string, uri: string) =>
    call<EditorFile>("live_language_source", { sessionId, uri }),
}
