import type { ReviewNotificationTarget } from "@/lib/desktop/contracts.generated"
import { reviewCommands } from "@/lib/desktop/review.commands"

type Target = ReviewNotificationTarget
type NotificationBridge = {
  listen: (receive: (target: Target) => void) => Promise<() => void>
  pending: () => Promise<Target | null>
  acknowledge: (operationId: string) => Promise<void>
}

export async function loadReviewNotification(
  target: Target,
  commands: Pick<
    typeof reviewCommands,
    "repositories" | "open" | "load"
  > = reviewCommands
) {
  const repositories = await commands.repositories()
  const saved = repositories.find((repo) => repo.id === target.repositoryId)
  if (!saved)
    throw new Error("This review's repository is no longer available.")
  // A cold start has no mounted projects. Mount the saved checkout before
  // reading its review, without navigating through its latest review.
  const repository = await commands.open(saved.path)
  if (repository.id !== target.repositoryId)
    throw new Error("This review's repository location has changed.")
  const workspace = await commands.load(target.reviewId, target.repositoryId)
  if (
    workspace.review.id !== target.reviewId ||
    workspace.review.repositoryId !== target.repositoryId
  )
    throw new Error("This notification no longer matches the requested review.")
  return { repositories, repository, workspace }
}

/** Subscribe before reading the pending click, including during a cold start. */
export function connectReviewNotifications(
  bridge: NotificationBridge,
  open: (target: Target) => Promise<void>,
  reportError: (error: unknown) => void
) {
  let disposed = false
  let unlisten: (() => void) | undefined
  const received = new Set<string>()
  const receive = (target: Target) => {
    if (disposed || received.has(target.operationId)) return
    received.add(target.operationId)
    void Promise.resolve()
      .then(() => {
        if (!disposed) return open(target)
      })
      .catch((error) => {
        if (!disposed) reportError(error)
      })
      .then(async () => {
        // A failed/deleted destination is reported once, rather than trapping
        // the reader in repeated navigation. A newer click cannot be cleared.
        if (!disposed) await bridge.acknowledge(target.operationId)
      })
      .catch((error) => {
        if (!disposed) reportError(error)
      })
  }
  void bridge
    .listen(receive)
    .then(async (stop) => {
      if (disposed) return stop()
      unlisten = stop
      const target = await bridge.pending()
      if (target) receive(target)
    })
    .catch((error) => {
      if (!disposed) reportError(error)
    })
  return () => {
    disposed = true
    unlisten?.()
  }
}
