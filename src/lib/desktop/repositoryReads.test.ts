import { expect, test } from "bun:test"
import {
  createRepositoryReadDispatcher,
  mergeRepositoryChanges,
  hasSourceChanges,
} from "./repositoryReads"
import type { RepositoryReadChange } from "./contracts.generated"
const change = (
  repositoryId: string,
  paths: string[]
): RepositoryReadChange => ({
  repositoryId,
  paths,
  tree: false,
  git: false,
  full: false,
})

test("bursts coalesce by checkout, preserve all paths and stop after unsubscribe", async () => {
  const bus = createRepositoryReadDispatcher(10)
  const received: RepositoryReadChange[] = []
  const stop = bus.subscribe("one", (event) => received.push(event))
  bus.receive(change("one", ["a"]))
  bus.receive(change("two", ["other"]))
  bus.receive({ ...change("one", ["a", "b"]), tree: true })
  await Bun.sleep(30)
  expect(received).toEqual([{ ...change("one", ["a", "b"]), tree: true }])
  bus.receive(change("one", ["late"]))
  stop()
  await Bun.sleep(30)
  expect(received).toHaveLength(1)
  bus.dispose()
})
test("overflow becomes bounded full reconciliation, including earlier scopes", () => {
  const next = mergeRepositoryChanges(
    change(
      "one",
      Array.from({ length: 512 }, (_, i) => String(i))
    ),
    change("one", ["extra"])
  )
  expect(next).toEqual({
    repositoryId: "one",
    paths: [],
    tree: true,
    git: true,
    full: true,
  })
})

test("native sequence delivery is immediate, rejects old batches and reconciles gaps", () => {
  const bus = createRepositoryReadDispatcher()
  const received: RepositoryReadChange[] = []
  bus.subscribe("one", (event) => received.push(event))
  bus.receive({ ...change("one", ["a"]), generation: "g1", sequence: 1 })
  expect(received).toHaveLength(1)
  bus.receive({ ...change("one", ["old"]), generation: "g1", sequence: 1 })
  expect(received).toHaveLength(1)
  bus.receive({ ...change("one", ["new"]), generation: "g1", sequence: 3 })
  expect(received.at(-1)?.full).toBe(true)
  bus.receive({
    ...change("one", ["new generation"]),
    generation: "g2",
    sequence: 1,
  })
  expect(received.at(-1)?.full).toBe(true)
  bus.dispose()
})

test("metadata changes reach explorers without invalidating source consumers", () => {
  const change = {
    repositoryId: "checkout",
    paths: [".reviewbox/CURRENT_CHANGES.md"],
    tree: false,
    git: false,
    full: false,
  }
  expect(hasSourceChanges(change)).toBe(false)
  expect(
    hasSourceChanges({ ...change, paths: [".reviewbox/.gitignore"] })
  ).toBe(false)
  expect(
    hasSourceChanges({
      ...change,
      paths: [".reviewbox/CURRENT_CHANGES.md", "src/main.ts"],
    })
  ).toBe(true)
  expect(hasSourceChanges({ ...change, full: true })).toBe(true)
})
