import { expect, test } from "bun:test"
import type {
  Repository,
  Workspace,
  ReviewNotificationTarget as Target,
} from "@/lib/desktop/contracts.generated"
import {
  connectReviewNotifications,
  loadReviewNotification,
} from "./reviewNotifications"

const target: Target = {
  operationId: "operation",
  repositoryId: "other-checkout",
  reviewId: "exact-review",
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test("a cold start mounts the notified checkout before loading its exact review", async () => {
  const repository: Repository = {
    id: target.repositoryId,
    path: "/saved/checkout",
    name: "project",
    branch: "main",
    openedAt: "1",
  }
  const workspace = {
    review: { id: target.reviewId, repositoryId: target.repositoryId },
  } as Workspace
  const calls: string[] = []
  const loaded = await loadReviewNotification(target, {
    repositories: async () => [repository],
    open: async (path) => {
      calls.push(`open:${path}`)
      return repository
    },
    load: async (id, checkout) => {
      calls.push(`load:${checkout}/${id}`)
      return workspace
    },
  })
  expect(calls).toEqual([
    "open:/saved/checkout",
    "load:other-checkout/exact-review",
  ])
  expect(loaded.workspace).toBe(workspace)
  expect(loaded.repository).toBe(repository)
})

test("a removed or relocated checkout never falls back to the active review", async () => {
  const missing = {
    repositories: async (): Promise<Repository[]> => [],
    open: async (): Promise<Repository> => {
      throw new Error("Must not open an unrelated checkout")
    },
    load: async (): Promise<Workspace> => {
      throw new Error("Must not load another review")
    },
  }
  await expect(loadReviewNotification(target, missing)).rejects.toThrow(
    "no longer available"
  )
  const repository: Repository = {
    id: target.repositoryId,
    path: "/saved/checkout",
    name: "project",
    branch: "main",
    openedAt: "1",
  }
  await expect(
    loadReviewNotification(target, {
      ...missing,
      repositories: async () => [repository],
      open: async () => ({ ...repository, id: "different-checkout" }),
    })
  ).rejects.toThrow("location has changed")
})

test("a mismatched review response cannot replace the current reader", async () => {
  const repository: Repository = {
    id: target.repositoryId,
    path: "/saved/checkout",
    name: "project",
    branch: "main",
    openedAt: "1",
  }
  await expect(
    loadReviewNotification(target, {
      repositories: async () => [repository],
      open: async () => repository,
      load: async () =>
        ({
          review: { id: "latest-but-unrelated", repositoryId: repository.id },
        }) as Workspace,
    })
  ).rejects.toThrow("no longer matches")
})

test("a cold-start click and its event open the exact review only once", async () => {
  let receive: (target: Target) => void = () => {}
  const opened: Target[] = []
  const acknowledged: string[] = []
  let stopped = false
  const dispose = connectReviewNotifications(
    {
      listen: async (handler) => {
        receive = handler
        return () => {
          stopped = true
        }
      },
      pending: async () => {
        receive(target)
        return target
      },
      acknowledge: async (id) => {
        acknowledged.push(id)
      },
    },
    async (value) => {
      opened.push(value)
    },
    () => {
      throw new Error("Unexpected error")
    }
  )
  await tick()
  expect(opened).toEqual([target])
  expect(acknowledged).toEqual([target.operationId])
  dispose()
  receive({ ...target, operationId: "newer" })
  await tick()
  expect(stopped).toBe(true)
  expect(opened).toHaveLength(1)
})

test("an unavailable review reports an error once and acknowledges only that click", async () => {
  const errors: unknown[] = []
  const acknowledged: string[] = []
  const cause = new Error("Review no longer exists")
  const dispose = connectReviewNotifications(
    {
      listen: async () => () => {},
      pending: async () => target,
      acknowledge: async (id) => {
        acknowledged.push(id)
      },
    },
    async () => {
      throw cause
    },
    (error) => {
      errors.push(error)
    }
  )
  await tick()
  expect(errors).toEqual([cause])
  expect(acknowledged).toEqual([target.operationId])
  dispose()
})

test("cleanup during subscription leaves the pending cold-start click for the next mount", async () => {
  let subscribe!: (stop: () => void) => void
  let stopped = false
  let pendingReads = 0
  const dispose = connectReviewNotifications(
    {
      listen: () =>
        new Promise((resolve) => {
          subscribe = resolve
        }),
      pending: async () => {
        pendingReads++
        return target
      },
      acknowledge: async () => {
        throw new Error("Must not acknowledge after disposal")
      },
    },
    async () => {
      throw new Error("Must not navigate after disposal")
    },
    () => {}
  )
  dispose()
  subscribe(() => {
    stopped = true
  })
  await tick()
  expect(stopped).toBe(true)
  expect(pendingReads).toBe(0)
})
