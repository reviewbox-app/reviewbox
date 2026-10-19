import { expect, test } from "bun:test"
import { groupFiles } from "./groupFiles.helpers"

test("skips wrapper directories and keeps related subfolders together", () => {
  const paths = ["review", "settings"].flatMap((name) =>
    ["components/Panel.tsx", "hooks/useData.ts", "types.ts"].map(
      (p) => `src/features/${name}/${p}`
    )
  )
  expect(groupFiles(paths).map((g) => g.path)).toEqual([
    "src/features/review",
    "src/features/settings",
  ])
  expect(groupFiles([...paths].reverse())).toEqual(groupFiles(paths))
})
test("preserves every path once, including root files and sparse siblings", () => {
  const paths = [
    "README.md",
    "src/a/x.ts",
    "src/b/y.ts",
    ...Array.from({ length: 20 }, (_, i) => `src/core/${i}.ts`),
  ]
  const groups = groupFiles([...paths, paths[0]])
  expect(groups.flatMap((g) => g.paths).sort()).toEqual(paths.sort())
  for (const group of groups)
    expect(
      group.paths.every((p) => !group.path || p.startsWith(group.path + "/"))
    ).toBe(true)
})
test("handles empty, single and deep inventories without empty headings", () => {
  expect(groupFiles([])).toEqual([])
  expect(groupFiles(["one/two/three/a.txt"])).toEqual([
    { path: "one/two/three", paths: ["one/two/three/a.txt"] },
  ])
  expect(groupFiles(["folder/"])).toEqual([])
})

test("groups two related files under their common parent and keeps singletons at root", () => {
  const paths = [
    "Gemfile",
    "README.md",
    "config/routes.rb",
    "db/migrate/add_state.rb",
    "db/schema.rb",
  ]
  expect(groupFiles(paths)).toEqual([
    { path: "", paths: ["Gemfile", "README.md", "config/routes.rb"] },
    { path: "db", paths: ["db/migrate/add_state.rb", "db/schema.rb"] },
  ])
})
