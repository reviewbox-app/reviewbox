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
  ).toEqual({ src: "A", "src/new": "A", "src/deep": "D" })
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
  expect(html).not.toContain('data-git-status="M"')
  expect(html).not.toContain("aria-expanded")
})

test("Code Editor keeps folders collapsible and initially closed", () => {
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

test("reviewed files fade while folders stay fully opaque", () => {
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
  expect(html.match(/opacity-50/g)).toHaveLength(1)
  expect(html).not.toContain("All files reviewed.")
  expect(html).toContain("Reviewed.")
  expect(html).not.toMatch(/<li[^>]*opacity-50/)
  expect(html).not.toContain("disabled")
})

test("local files start expanded with collapse controls, status colors and file-only dimmed badges", () => {
  const html = renderToStaticMarkup(
    <FileTree
      paths={["src/deleted.ts", "src/ready.ts"]}
      selected=""
      marks={{}}
      statuses={{ "src/deleted.ts": "D", "src/ready.ts": "M" }}
      reviewedPaths={new Set(["src/ready.ts"])}
      defaultExpanded
      onSelect={() => {}}
    />
  )
  expect(html).toContain('aria-expanded="true"')
  expect(html.match(/data-git-status=/g)).toHaveLength(2)
  expect(html).toContain("text-diff-removed")
  expect(html).toContain("text-git-modified")
  expect(html).toContain("opacity-75")
  expect(html.match(/opacity-50/g)).toHaveLength(3)
  expect(html).not.toMatch(/<li[^>]*opacity-/)
})

test("local folder colors prioritize added, edited, then deleted at every ancestor regardless of order", () => {
  const statuses = {
    "src/removed/deep/a.ts": "D",
    "src/edited/deep/a.ts": "D",
    "src/edited/b.ts": "R",
    "src/added/deep/a.ts": "U",
    "src/added/b.ts": "M",
  } as const
  const expected = {
    src: "A",
    "src/removed": "D",
    "src/removed/deep": "D",
    "src/edited": "M",
    "src/edited/deep": "D",
    "src/added": "A",
    "src/added/deep": "A",
  } as const
  expect(folderGitStatuses(statuses)).toEqual(expected)
  expect(
    folderGitStatuses(Object.fromEntries(Object.entries(statuses).reverse()))
  ).toEqual(expected)
  const html = renderToStaticMarkup(
    <FileTree
      paths={Object.keys(statuses)}
      selected=""
      marks={{}}
      statuses={statuses}
      defaultExpanded
      onSelect={() => {}}
    />
  )
  expect(html).toContain('text-diff-added">src</span>')
  expect(html).toContain('text-git-modified">edited</span>')
  expect(html).toContain('text-diff-removed">removed/deep</span>')
})

test("folder color uses filtered-out descendants and folder rows support shared menus", () => {
  const wrapped: string[] = []
  const html = renderToStaticMarkup(
    <FileTree
      paths={["src/deleted.ts"]}
      selected="src/deleted.ts"
      marks={{ "src/deleted.ts": "validated" }}
      statuses={{ "src/deleted.ts": "D", "src/hidden.ts": "A" }}
      reviewedPaths={new Set(["src", "src/deleted.ts"])}
      alwaysExpanded
      renderRow={(row, target) => {
        wrapped.push(target.path)
        return row
      }}
      onSelect={() => {}}
    />
  )
  expect(wrapped).toEqual(["src", "src/deleted.ts"])
  expect(html).toContain('data-folder="src" tabindex="0"')
  expect(html).toContain('text-diff-added">src</span>')
  expect(html).toContain('aria-label="Validated"')
  expect(html).toContain('aria-current="page"')
  expect(html).not.toMatch(/data-folder="src"[^>]*opacity-/)
  expect(html.match(/data-git-status=/g)).toHaveLength(1)
})

test("only entirely ignored folders fade, using the full inventory without cascading opacity", () => {
  const html = renderToStaticMarkup(
    <FileTree
      paths={[
        "cache/deep/a.txt",
        "cache/top.txt",
        "mixed/ignored.txt",
        "empty/",
      ]}
      allPaths={[
        "cache/deep/a.txt",
        "cache/top.txt",
        "mixed/ignored.txt",
        "mixed/visible.txt",
        "empty/",
      ]}
      ignoredPaths={
        new Set(["cache/deep/a.txt", "cache/top.txt", "mixed/ignored.txt"])
      }
      selected=""
      marks={{}}
      defaultExpanded
      onSelect={() => {}}
    />
  )
  expect(html).toMatch(/data-folder="cache"[^>]*opacity-60/)
  expect(html).toMatch(/data-folder="cache\/deep"[^>]*opacity-60/)
  expect(html).not.toMatch(/data-folder="mixed"[^>]*opacity-/)
  expect(html).not.toMatch(/data-folder="empty"[^>]*opacity-/)
  expect(html).not.toMatch(/<(?:li|ul)[^>]*opacity-/)
})

test("compacted ignored-only folder chains also fade", () => {
  const html = renderToStaticMarkup(
    <FileTree
      paths={["cache/nested/only.txt"]}
      ignoredPaths={new Set(["cache/nested/only.txt"])}
      selected=""
      marks={{}}
      alwaysExpanded
      onSelect={() => {}}
    />
  )
  expect(html).toMatch(/data-folder="cache\/nested"[^>]*opacity-60/)
})
