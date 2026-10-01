import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { Snapshot } from "@/lib/desktop/contracts.generated"
import { capturedFileStatuses, folderGitStatuses } from "@/lib/git/file-status"
import { FileTree } from "./FileTree"

const blob = { hash: "hash", size: 1, mode: "100644" }
function change(
  path: string,
  extra: Partial<Snapshot["changes"][number]> = {}
): Snapshot["changes"][number] {
  return {
    id: path,
    path,
    previousPath: null,
    layer: "unstaged",
    before: blob,
    after: blob,
    binary: false,
    untracked: false,
    passages: [],
    ...extra,
  }
}

test("Git statuses preserve additions across staged edits, renames and deletion layers", () => {
  expect(
    capturedFileStatuses(
      [
        change("added.ts", { before: null, layer: "staged" }),
        change("added.ts"),
        change("deleted.ts", { layer: "staged" }),
        change("deleted.ts", { after: null }),
        change("renamed.ts", { previousPath: "old.ts", layer: "staged" }),
        change("renamed.ts"),
        change("untracked.ts", { before: null, untracked: true }),
        change("modified.ts"),
      ].reverse()
    )
  ).toEqual({
    "added.ts": "A",
    "deleted.ts": "D",
    "renamed.ts": "R",
    "untracked.ts": "U",
    "modified.ts": "M",
  })
})

test("folders aggregate all descendants, including compacted paths and mixed statuses", () => {
  expect(
    folderGitStatuses({
      "src/new/a.ts": "A",
      "src/new/b.ts": "A",
      "src/deep/old.ts": "D",
    })
  ).toEqual({ src: "M", "src/new": "A", "src/deep": "D" })
})

test("Review folders always expose every file and their Git status without collapse buttons", () => {
  const html = renderToStaticMarkup(
    <FileTree
      paths={["src/feature/a.ts", "src/feature/b.ts"]}
      selected="src/feature/a.ts"
      marks={{}}
      statuses={{ "src/feature/a.ts": "A", "src/feature/b.ts": "D" }}
      alwaysExpanded
      onSelect={() => {}}
    />
  )
  expect(html).toContain("src/feature")
  expect(html).toContain('title="src/feature/a.ts"')
  expect(html).toContain('title="src/feature/b.ts"')
  expect(html).toContain('data-git-status="A"')
  expect(html).toContain('data-git-status="D"')
  expect(html).toContain('data-git-status="M"')
  expect(html).not.toContain("aria-expanded")
})

test("Code Explain keeps folders collapsible and initially closed", () => {
  const html = renderToStaticMarkup(
    <FileTree
      paths={["src/feature/a.ts"]}
      selected=""
      marks={{}}
      onSelect={() => {}}
    />
  )
  expect(html).toContain('aria-expanded="false"')
  expect(html).not.toContain('title="src/feature/a.ts"')
})

test("reviewed rows fade separately, without multiplying opacity through parent folders", () => {
  const html = renderToStaticMarkup(
    <FileTree
      paths={["src/feature/a.ts"]}
      selected="src/feature/a.ts"
      marks={{}}
      reviewedPaths={new Set(["src/feature", "src/feature/a.ts"])}
      alwaysExpanded
      onSelect={() => {}}
    />
  )
  expect(html.match(/opacity-50/g)).toHaveLength(2)
  expect(html).toContain("All files reviewed.")
  expect(html).toContain("Reviewed.")
  expect(html).not.toMatch(/<li[^>]*opacity-50/)
  expect(html).not.toContain("disabled")
})
