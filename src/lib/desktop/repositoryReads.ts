import { listen } from "@tauri-apps/api/event"
import { desktopAvailable } from "./review.commands"
import type { RepositoryReadChange } from "./contracts.generated"

export function mergeRepositoryChanges(
  previous: RepositoryReadChange | undefined,
  next: RepositoryReadChange
): RepositoryReadChange {
  const paths = new Set([...(previous?.paths ?? []), ...next.paths])
  const full = !!previous?.full || next.full || paths.size > 512
  return {
    repositoryId: next.repositoryId,
    paths: full ? [] : [...paths],
    tree: full || !!previous?.tree || next.tree,
    git: full || !!previous?.git || next.git,
    full,
  }
}

/** One bounded batch per checkout/window, shared by all feature subscribers.
 * A fixed window (rather than trailing debounce) also flushes during continuous writes.
 */
export function createRepositoryReadDispatcher(delay = 200) {
  const subscribers = new Map<
    string,
    Set<(change: RepositoryReadChange) => void>
  >()
  const pending = new Map<string, RepositoryReadChange>()
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    subscribe(id: string, callback: (change: RepositoryReadChange) => void) {
      const group = subscribers.get(id) ?? new Set()
      group.add(callback)
      subscribers.set(id, group)
      return () => {
        group.delete(callback)
        if (!group.size) {
          subscribers.delete(id)
          pending.delete(id)
        }
      }
    },
    receive(change: RepositoryReadChange) {
      if (!subscribers.has(change.repositoryId)) return
      pending.set(
        change.repositoryId,
        mergeRepositoryChanges(pending.get(change.repositoryId), change)
      )
      timer ??= setTimeout(() => {
        timer = undefined
        const batch = [...pending.values()]
        pending.clear()
        for (const change of batch)
          for (const callback of subscribers.get(change.repositoryId) ?? [])
            callback(change)
      }, delay)
    },
    dispose() {
      clearTimeout(timer)
      pending.clear()
      subscribers.clear()
    },
  }
}

let shared:
  | {
      dispatcher: ReturnType<typeof createRepositoryReadDispatcher>
      count: number
      stop: () => void
    }
  | undefined

/** Notifications are hints; feature-owned focus/fallback reconciliation covers misses. */
export function subscribeRepositoryReads(
  repositoryId: string,
  refresh: (change: RepositoryReadChange) => void
) {
  if (!desktopAvailable()) return () => {}
  if (!shared) {
    const dispatcher = createRepositoryReadDispatcher()
    let disposed = false
    const subscription = listen<RepositoryReadChange>(
      "reviewbox:repository-read-invalidated",
      ({ payload }) => {
        if (!disposed) dispatcher.receive(payload)
      }
    ).catch(() => undefined)
    shared = {
      dispatcher,
      count: 0,
      stop: () => {
        disposed = true
        dispatcher.dispose()
        void subscription.then((unlisten) => unlisten?.())
      },
    }
  }
  const owner = shared
  owner.count++
  const unsubscribe = owner.dispatcher.subscribe(repositoryId, refresh)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    unsubscribe()
    if (--owner.count === 0) {
      owner.stop()
      if (shared === owner) shared = undefined
    }
  }
}
