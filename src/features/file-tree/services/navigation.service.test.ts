import { afterEach, expect, spyOn, test } from "bun:test"
import * as desktop from "@/lib/desktop/review.commands"
import type { CheckoutNavigation } from "@/lib/desktop/contracts.generated"
import {
  emptyTree,
  navigationCommands,
  flushTreeNavigation,
  loadTreeNavigation,
  remapTreeNavigation,
  treeNavigation,
  updateTreeNavigation,
  useTreeNavigation,
} from "./navigation.service"

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
})
function setup() {
  const repo = crypto.randomUUID()
  let disk: CheckoutNavigation = { revision: 0, trees: {} }
  let exists = false
  const writes: CheckoutNavigation[] = []
  const available = spyOn(desktop, "desktopAvailable").mockReturnValue(true)
  const load = spyOn(navigationCommands, "load").mockImplementation(async () =>
    structuredClone(disk)
  )
  const save = spyOn(navigationCommands, "save").mockImplementation(
    async (_, next) => {
      expect(next.revision).toBe(disk.revision)
      disk = structuredClone({
        ...next,
        revision: exists ? next.revision + 1 : 0,
      })
      exists = true
      writes.push(disk)
      return disk
    }
  )
  cleanup.push(() => {
    available.mockRestore()
    load.mockRestore()
    save.mockRestore()
    useTreeNavigation.setState({ checkouts: {} })
  })
  return { repo, writes, disk: () => disk }
}
test("private checkout navigation restores expansion, selection, scroll and live mode without serializing search", async () => {
  const { repo, writes } = setup()
  await loadTreeNavigation(repo)
  updateTreeNavigation(repo, "editor", (tree) => ({
    ...tree,
    expandedPaths: ["src", ".reviewbox"],
    selectedPath: "src/a.ts",
    scrollTop: 240,
  }))
  updateTreeNavigation(repo, "local", (tree) => ({ ...tree, mode: "changes" }))
  await flushTreeNavigation(repo)
  expect(writes.at(-1)?.trees.editor).toEqual({
    ...emptyTree(),
    expandedPaths: ["src", ".reviewbox"],
    selectedPath: "src/a.ts",
    scrollTop: 240,
  })
  useTreeNavigation.setState({ checkouts: {} })
  await loadTreeNavigation(repo)
  expect(treeNavigation(repo, "local")?.mode).toBe("changes")
  expect(treeNavigation(repo, "editor")?.scrollTop).toBe(240)
  expect(Object.keys(treeNavigation(repo, "editor") ?? {})).not.toContain(
    "filter"
  )
})
test("renames retain descendant expansion and selected files; trash prunes them", async () => {
  const { repo } = setup()
  await loadTreeNavigation(repo)
  updateTreeNavigation(repo, "editor", (tree) => ({
    ...tree,
    expandedPaths: ["src", "src/deep", "src-other"],
    selectedPath: "src/deep/file.ts",
  }))
  remapTreeNavigation(repo, "src", "lib")
  expect(treeNavigation(repo, "editor")?.expandedPaths).toEqual([
    "lib",
    "lib/deep",
    "src-other",
  ])
  expect(treeNavigation(repo, "editor")?.selectedPath).toBe("lib/deep/file.ts")
  remapTreeNavigation(repo, "lib")
  expect(treeNavigation(repo, "editor")?.expandedPaths).toEqual(["src-other"])
  expect(treeNavigation(repo, "editor")?.selectedPath).toBeNull()
  await flushTreeNavigation(repo)
})
test("queued writes use the latest revision and keep navigation surfaces independent", async () => {
  const { repo, disk } = setup()
  await loadTreeNavigation(repo)
  updateTreeNavigation(repo, "editor", (tree) => ({
    ...tree,
    expandedPaths: ["one"],
  }))
  const first = flushTreeNavigation(repo)
  updateTreeNavigation(repo, "review:review-one", (tree) => ({
    ...tree,
    expandedPaths: ["review-only"],
  }))
  const second = flushTreeNavigation(repo)
  await Promise.all([first, second])
  expect(disk().revision).toBe(1)
  expect(disk().trees.editor.expandedPaths).toEqual(["one"])
  expect(disk().trees["review:review-one"].expandedPaths).toEqual([
    "review-only",
  ])
})
