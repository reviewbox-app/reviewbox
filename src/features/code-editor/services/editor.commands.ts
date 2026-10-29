import { Channel } from "@tauri-apps/api/core"
import { call } from "@/lib/desktop/review.commands"
import type {
  EditorEntry,
  EditorWatchStatus,
  RepositoryReadChange,
  EditorSearchBatch,
  EditorSearchBuffer,
  EditorSearchResult,
  EditorFile,
  EditorMutation,
  EditorRecovery,
} from "@/lib/desktop/contracts.generated"

export const editorCommands = {
  search: (
    repositoryId: string,
    query: string,
    requestId: string,
    owner: string,
    buffers: EditorSearchBuffer[],
    paths: string[] | undefined,
    receive: (batch: EditorSearchBatch) => void
  ) => {
    const onBatch = new Channel<EditorSearchBatch>()
    onBatch.onmessage = receive
    return call<EditorSearchResult>("editor_search_content", {
      repositoryId,
      query,
      requestId,
      owner,
      buffers,
      paths,
      onBatch,
    })
  },
  cancelSearch: (requestId: string, owner: string, repositoryId: string) =>
    call<void>("editor_cancel_search", { requestId, owner, repositoryId }),
  watchStatus: (repositoryId: string) =>
    call<EditorWatchStatus>("editor_watch_status", { repositoryId }),
  inventory: (
    repositoryId: string,
    showIgnored: boolean,
    expandedPaths: string[] = [],
    change?: RepositoryReadChange
  ) =>
    call<EditorEntry[]>("editor_inventory", {
      repositoryId,
      showIgnored,
      expandedPaths,
      change,
    }),
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
