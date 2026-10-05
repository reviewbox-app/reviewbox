import { expect, test } from "bun:test"
import {
  createEditorSearch,
  searchablePaths,
  searchRefreshPaths,
  type EditorSearchSnapshot,
} from "./editorSearch.service"
import type { editorCommands } from "./editor.commands"
import type {
  EditorSearchResult,
  EditorSearchMatch,
  EditorEntry,
  RepositoryReadChange,
} from "@/lib/desktop/contracts.generated"

test("Git exclusions reconcile search while index-only events leave it alone", () => {
  const change: RepositoryReadChange = {
    repositoryId: "checkout",
    paths: [],
    tree: false,
    git: true,
    full: false,
  }
  expect(searchRefreshPaths(change, [])).toEqual([])
  expect(searchRefreshPaths({ ...change, tree: true }, [])).toBeUndefined()
  expect(
    searchRefreshPaths({ ...change, git: false, paths: ["nested/.ignore"] }, [])
  ).toBeUndefined()
})

test("expanded excluded directories stay excluded but ignored-only parents accept new sources", () => {
  const entries: EditorEntry[] = [
    {
      path: "node_modules",
      directory: true,
      revision: "",
      ignored: true,
      excluded: true,
      lazy: false,
    },
    {
      path: "src",
      directory: true,
      revision: "",
      ignored: true,
      excluded: false,
      lazy: false,
    },
    {
      path: "src/generated.js",
      directory: false,
      revision: "",
      ignored: true,
      excluded: true,
    },
  ]
  expect(
    searchablePaths(
      ["node_modules/new/index.js", "src/main.ts", "src/generated.js"],
      entries
    )
  ).toEqual(["src/main.ts"])
  expect(
    searchRefreshPaths(
      {
        repositoryId: "checkout",
        paths: ["node_modules/new/index.js"],
        tree: true,
        git: false,
        full: false,
      },
      entries
    )
  ).toEqual([])
})

const match = (path: string, line = 1): EditorSearchMatch => ({
  path,
  line,
  column: 1,
  length: 1,
  preview: "x",
  previewColumn: 1,
})
const result = (requestId: string, paths: string[]): EditorSearchResult => ({
  requestId,
  matches: paths.map((path) => match(path)),
  truncated: false,
  cancelled: false,
  scannedFiles: paths.length,
  skippedFiles: 0,
})
function fixture(initial?: EditorSearchResult) {
  type Search = Parameters<typeof editorCommands.search>
  type Pending = { args: Search; resolve: (value: EditorSearchResult) => void }
  const requests: Pending[] = []
  const snapshots: EditorSearchSnapshot[] = []
  const cancelled: string[] = []
  let notify: ((value: Pending) => void) | undefined
  const operation = createEditorSearch({
    repositoryId: "checkout",
    query: "x",
    owner: "view",
    initial,
    delay: 0,
    buffers: () => [{ path: "open.rs", text: "unsaved x", version: 2 }],
    publish: (snapshot) => snapshots.push(snapshot),
    transport: {
      search: (...args) =>
        new Promise((resolve) => {
          const pending = { args, resolve }
          if (notify) {
            const next = notify
            notify = undefined
            next(pending)
          } else requests.push(pending)
        }),
      cancelSearch: async (requestId, owner, checkout) => {
        expect(owner).toBe("view")
        expect(checkout).toBe("checkout")
        cancelled.push(requestId)
      },
    },
  })
  const next = () =>
    requests.length
      ? Promise.resolve(requests.shift()!)
      : new Promise<Pending>((resolve) => {
          notify = resolve
        })
  return { operation, next, snapshots, cancelled }
}

test("streams ordered results, preserves visible results on refresh and ignores stale replies", async () => {
  const { operation, next, snapshots, cancelled } = fixture(
    result("old", ["old.rs"])
  )
  operation.refresh()
  expect(snapshots.at(-1)?.result?.matches[0].path).toBe("old.rs")
  const first = await next()
  expect(first.args[4][0].text).toBe("unsaved x")
  first.args[6]({
    requestId: first.args[2],
    sequence: 1,
    matches: [match("first.rs")],
  })
  first.args[6]({
    requestId: first.args[2],
    sequence: 1,
    matches: [match("duplicate.rs")],
  })
  expect(snapshots.at(-1)?.result?.matches.map((m) => m.path)).toEqual([
    "first.rs",
  ])
  operation.refresh()
  const second = await next()
  expect(cancelled).toContain(first.args[2])
  first.resolve(result(first.args[2], ["obsolete.rs"]))
  second.resolve(result(second.args[2], ["current.rs"]))
  await Promise.resolve()
  expect(snapshots.at(-1)?.pending).toBe(false)
  expect(snapshots.at(-1)?.result?.matches.map((m) => m.path)).toEqual([
    "current.rs",
  ])
  operation.dispose()
})

test("interrupted partial updates requeue their paths and keep unrelated matches", async () => {
  const { operation, next, snapshots } = fixture()
  operation.refresh()
  const full = await next()
  full.resolve(result(full.args[2], ["a.rs", "b.rs", "c.rs"]))
  await Promise.resolve()
  operation.refresh(["a.rs"])
  const a = await next()
  expect(a.args[5]).toEqual(["a.rs"])
  a.args[6]({ requestId: a.args[2], sequence: 1, matches: [match("a.rs", 2)] })
  operation.refresh(["b.rs"])
  const both = await next()
  expect(both.args[5]?.sort()).toEqual(["a.rs", "b.rs"])
  both.resolve(result(both.args[2], ["b.rs"]))
  a.resolve(result(a.args[2], ["a.rs"]))
  await Promise.resolve()
  expect(snapshots.at(-1)?.result?.matches.map((m) => m.path)).toEqual([
    "b.rs",
    "c.rs",
  ])
  operation.dispose()
})
