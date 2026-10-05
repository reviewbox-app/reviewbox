import type { EditorWatchStatus } from "./contracts.generated"

/** Health owns the safety timer; healthy watchers never poll repository data. */
export function createRepositoryReadReconciliation({
  readStatus,
  reconcile,
  visible = () => document.visibilityState === "visible",
  schedule = (work, delay) => {
    const timer = setTimeout(work, delay)
    return () => clearTimeout(timer)
  },
}: {
  readStatus: () => Promise<EditorWatchStatus>
  reconcile: () => void
  visible?: () => boolean
  schedule?: (work: () => void, delay: number) => () => void
}) {
  let disposed = false
  let running = false
  let queued = false
  let queuedFallback = false
  let healthy: boolean | undefined
  let missedChanges = false
  let cancelTimer: (() => void) | undefined

  const check = async (fallback = false) => {
    if (disposed || !visible()) return
    if (running) {
      queued = true
      queuedFallback ||= fallback
      return
    }
    cancelTimer?.()
    cancelTimer = undefined
    running = true
    try {
      const status = await readStatus()
      if (disposed) return
      healthy = status.healthy
      missedChanges ||= !healthy
      // A safety check reconciles while degraded and once after recovery.
      // Focus and full events already requested their own feature refresh.
      if (fallback && missedChanges) {
        reconcile()
        missedChanges = !healthy
      }
    } catch {
      // An unknown health result retries health only, without replacing feature errors.
      healthy = undefined
    } finally {
      running = false
      if (!disposed) {
        if (queued) {
          const fallback = queuedFallback
          queued = false
          queuedFallback = false
          void check(fallback)
        } else if (healthy !== true) {
          cancelTimer = schedule(() => void check(true), 30000)
        }
      }
    }
  }

  return {
    registered() {
      if (disposed) return
      cancelTimer?.()
      // Native watcher registration continues briefly after acquiring its lease.
      cancelTimer = schedule(() => void check(), 1000)
    },
    focus() {
      if (disposed || !visible()) return
      reconcile()
      missedChanges = false
      void check()
    },
    invalidated() {
      void check()
    },
    dispose() {
      disposed = true
      queued = false
      cancelTimer?.()
    },
  }
}
