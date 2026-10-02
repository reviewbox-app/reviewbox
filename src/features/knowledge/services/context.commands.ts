import type { Snapshot } from "@/lib/desktop/contracts.generated"
import { call } from "@/lib/desktop/review.commands"
import { SessionReadCache } from "@/lib/desktop/sessionReadCache"

export const contexts = new SessionReadCache<Snapshot>()
export const reading = new SessionReadCache<{ path: string; filter: string }>()
export const contents = new SessionReadCache<string>(12)
const pending = new Map<string, Promise<Snapshot>>()
export const contextCommands = {
  release: (repositoryId: string, contextId: string) =>
    call<void>("release_code_context", { repositoryId, contextId }),
  refresh(repositoryId: string) {
    const active = pending.get(repositoryId)
    if (active) return active
    const work = call<Snapshot>("code_explain_context", {
      repositoryId,
      current: contexts.get(repositoryId)?.id ?? null,
    })
      .then((value) => {
        contexts.set(repositoryId, value)
        return value
      })
      .finally(() => {
        pending.delete(repositoryId)
      })
    pending.set(repositoryId, work)
    return work
  },
}
