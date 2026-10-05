import { listen } from "@tauri-apps/api/event"
import { call, desktopAvailable } from "./review.commands"
import type {
  EditorWatchStatus,
  RepositoryReadChange,
} from "./contracts.generated"
import { createRepositoryReadReconciliation } from "./repositoryReadReconciliation"

export function mergeRepositoryChanges(
  previous: RepositoryReadChange | undefined,
  next: RepositoryReadChange
): RepositoryReadChange {
  const paths = new Set([...(previous?.paths ?? []), ...next.paths])
  const full = !!previous?.full || next.full || paths.size > 512
  return {
    repositoryId: next.repositoryId,
    ...(next.generation ? { generation: next.generation } : {}),
    ...(next.sequence !== undefined ? { sequence: next.sequence } : {}),
    ...(previous?.changes || next.changes
      ? {
          changes: full
            ? []
            : [
                ...new Map(
                  [...(previous?.changes ?? []), ...(next.changes ?? [])].map(
                    (change) => [change.path, change]
                  )
                ).values(),
              ],
        }
      : {}),
    paths: full ? [] : [...paths],
    tree: full || !!previous?.tree || next.tree,
    git: full || !!previous?.git || next.git,
    full,
  }
}

/** A shared ordered stream per checkout/window. An optional test/legacy batch stays bounded. */
export function createRepositoryReadDispatcher(delay = 0) {
  const subscribers = new Map<
    string,
    Set<(change: RepositoryReadChange) => void>
  >()
  const pending = new Map<string, RepositoryReadChange>()
  const revisions = new Map<string, { generation: string; sequence: number }>()
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
          revisions.delete(id)
        }
      }
    },
    receive(change: RepositoryReadChange) {
      if (!subscribers.has(change.repositoryId)) return
      if (change.generation && change.sequence !== undefined) {
        const { generation, sequence } = change
        const old = revisions.get(change.repositoryId)
        if (
          old?.generation === change.generation &&
          change.sequence <= old.sequence
        )
          return
        if (
          old &&
          (old.generation !== change.generation ||
            change.sequence > old.sequence + 1)
        )
          change = { ...change, full: true, tree: true, git: true, paths: [] }
        revisions.set(change.repositoryId, { generation, sequence })
      }
      // Rust already coalesces the native stream; do not add another latency window.
      if (delay === 0) {
        for (const callback of subscribers.get(change.repositoryId) ?? [])
          callback(change)
        return
      }
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
      revisions.clear()
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
  refresh: (change: RepositoryReadChange) => void,
  reconcile?: () => void
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
  const leaseOwner = crypto.randomUUID()
  const reconciliation = reconcile
    ? createRepositoryReadReconciliation({
        readStatus: () =>
          call<EditorWatchStatus>("editor_watch_status", { repositoryId }),
        reconcile,
      })
    : undefined
  const lease = call("editor_watch", {
    repositoryId,
    owner: leaseOwner,
    release: false,
  }).catch(() => undefined)
  void lease.then(() => reconciliation?.registered())
  const owner = shared
  owner.count++
  const unsubscribe = owner.dispatcher.subscribe(repositoryId, (change) => {
    refresh(change)
    if (change.full) reconciliation?.invalidated()
  })
  const focus = () => reconciliation?.focus()
  if (reconciliation) {
    window.addEventListener("focus", focus)
    document.addEventListener("visibilitychange", focus)
  }
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    reconciliation?.dispose()
    if (reconciliation) {
      window.removeEventListener("focus", focus)
      document.removeEventListener("visibilitychange", focus)
    }
    unsubscribe()
    void lease
      .then(() =>
        call("editor_watch", { repositoryId, owner: leaseOwner, release: true })
      )
      .catch(() => {})
    if (--owner.count === 0) {
      owner.stop()
      if (shared === owner) shared = undefined
    }
  }
}
