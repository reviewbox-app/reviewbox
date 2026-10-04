import { call } from "@/lib/desktop/review.commands"
import type {
  EditorEntry,
  EditorSearchResult,
  EditorFile,
  EditorMutation,
  EditorRecovery,
} from "@/lib/desktop/contracts.generated"

export const editorCommands = {
  search: (repositoryId: string, query: string, requestId: string) =>
    call<EditorSearchResult>("editor_search_content", {
      repositoryId,
      query,
      requestId,
    }),
  cancelSearch: (requestId: string) =>
    call<void>("editor_cancel_search", { requestId }),
  inventory: (repositoryId: string, showIgnored: boolean) =>
    call<EditorEntry[]>("editor_inventory", { repositoryId, showIgnored }),
  read: (repositoryId: string, path: string) =>
    call<EditorFile>("editor_read", { repositoryId, path }),
  revision: (repositoryId: string, path: string) =>
    call<string>("editor_revision", { repositoryId, path }),
  mutate: (repositoryId: string, mutation: EditorMutation) =>
    call<void>("editor_mutate", { repositoryId, mutation }),
  recovery: (repositoryId: string) =>
    call<EditorRecovery>("editor_recovery", { repositoryId }),
  storeRecovery: (repositoryId: string, recovery: EditorRecovery) =>
    call<EditorRecovery>("editor_store_recovery", { repositoryId, recovery }),
  dirty: (dirty: boolean) => call<void>("editor_dirty", { dirty }),
  exit: () => call<void>("editor_exit"),
}
