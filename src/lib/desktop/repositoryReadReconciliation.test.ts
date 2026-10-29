import { expect, test } from "bun:test"
import type { EditorWatchStatus } from "./contracts.generated"
import { createRepositoryReadReconciliation } from "./repositoryReadReconciliation"

const status = (healthy: boolean): EditorWatchStatus => ({
  healthy,
  generation: "watch",
  sequence: 0,
})
const settled = async () => {
  await Promise.resolve()
  await Promise.resolve()
}
function fixture() {
  const tasks = new Map<number, { work: () => void; delay: number }>()
  let nextId = 0
  let health: boolean | Error = true
  let visible = true
  let checks = 0
  let refreshes = 0
  const controller = createRepositoryReadReconciliation({
    readStatus: async () => {
      checks++
      if (health instanceof Error) throw health
      return status(health)
    },
    reconcile: () => refreshes++,
    visible: () => visible,
    schedule(work, delay) {
      const id = ++nextId
      tasks.set(id, { work, delay })
      return () => tasks.delete(id)
    },
  })
  return {
    controller,
    tasks,
    checks: () => checks,
    refreshes: () => refreshes,
    health: (value: boolean | Error) => (health = value),
    visible: (value: boolean) => (visible = value),
    async tick() {
      const [id, task] = tasks.entries().next().value!
      tasks.delete(id)
      task.work()
      await settled()
    },
  }
}

test("healthy registration and full events leave no periodic reconciliation", async () => {
  const f = fixture()
  f.controller.registered()
  expect([...f.tasks.values()].map((task) => task.delay)).toEqual([1000])
  await f.tick()
  expect(f.checks()).toBe(1)
  expect(f.refreshes()).toBe(0)
  expect(f.tasks.size).toBe(0)
  f.controller.invalidated()
  await settled()
  expect(f.checks()).toBe(2)
  expect(f.refreshes()).toBe(0)
  expect(f.tasks.size).toBe(0)
  f.controller.focus()
  await settled()
  expect(f.refreshes()).toBe(1)
  expect(f.tasks.size).toBe(0)
  f.controller.dispose()
})

test("only degraded watchers refresh on the bounded fallback and once on recovery", async () => {
  const f = fixture()
  f.health(false)
  f.controller.registered()
  await f.tick()
  expect(f.refreshes()).toBe(0)
  expect([...f.tasks.values()].map((task) => task.delay)).toEqual([30000])
  await f.tick()
  expect(f.refreshes()).toBe(1)
  f.health(true)
  await f.tick()
  expect(f.refreshes()).toBe(2)
  expect(f.tasks.size).toBe(0)
  f.controller.dispose()
})

test("unknown health retries status without refreshing data and retains known misses", async () => {
  const f = fixture()
  f.health(new Error("IPC unavailable"))
  f.controller.registered()
  await f.tick()
  await f.tick()
  expect(f.refreshes()).toBe(0)
  f.health(false)
  await f.tick()
  expect(f.refreshes()).toBe(1)
  f.health(new Error("IPC unavailable"))
  await f.tick()
  expect(f.refreshes()).toBe(1)
  f.health(true)
  await f.tick()
  expect(f.refreshes()).toBe(2)
  expect(f.tasks.size).toBe(0)
  f.controller.dispose()
})

test("hidden features pause fallback and reconcile when visible again", async () => {
  const f = fixture()
  f.health(false)
  f.controller.registered()
  await f.tick()
  f.visible(false)
  await f.tick()
  expect(f.checks()).toBe(1)
  expect(f.refreshes()).toBe(0)
  expect(f.tasks.size).toBe(0)
  f.controller.focus()
  expect(f.checks()).toBe(1)
  f.visible(true)
  f.health(true)
  f.controller.focus()
  await settled()
  expect(f.refreshes()).toBe(1)
  expect(f.tasks.size).toBe(0)
  f.controller.dispose()
})

test("disposal cancels registration and ignores an in-flight health reply", async () => {
  const f = fixture()
  f.controller.registered()
  f.controller.dispose()
  f.controller.registered()
  f.controller.focus()
  f.controller.invalidated()
  expect(f.tasks.size).toBe(0)
  expect(f.checks()).toBe(0)
  let resolve!: (value: EditorWatchStatus) => void
  let refreshes = 0
  let schedules = 0
  const controller = createRepositoryReadReconciliation({
    readStatus: () => new Promise((done) => (resolve = done)),
    reconcile: () => refreshes++,
    visible: () => true,
    schedule: () => {
      schedules++
      return () => {}
    },
  })
  controller.invalidated()
  controller.dispose()
  resolve(status(false))
  await settled()
  expect(refreshes).toBe(0)
  expect(schedules).toBe(0)
})
