import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { Nodes } from "hast"
import { MarkdownTreeRenderer } from "../components/MarkdownRenderer"
import { changedText, compareDocuments, nodeText } from "./documentDiff.helpers"

function compare(before: string | null, after: string | null) {
  return compareDocuments({ before, after })
}
function tags(node: Nodes): string[] {
  return [
    node.type === "element" ? node.tagName : "",
    ...("children" in node ? node.children.flatMap(tags) : []),
  ]
}
function marks(node: Nodes): string[] {
  return node.type === "element" && node.tagName === "mark"
    ? [nodeText(node)]
    : "children" in node
      ? node.children.flatMap(marks)
      : []
}

describe("captured document diff", () => {
  test("whole-file additions, removals and identical files", () => {
    const text = "# Title\n\nFirst paragraph.\n\nLast paragraph."
    expect(
      compare(null, text).rows.every(
        (row) => row.changed && row.after && !row.before
      )
    ).toBe(true)
    expect(
      compare(text, null).rows.every(
        (row) => row.changed && row.before && !row.after
      )
    ).toBe(true)
    expect(
      compare(text, text).rows.every(
        (row) => !row.changed && row.before && row.after
      )
    ).toBe(true)
    expect(compare(text, text).rows).toHaveLength(3)
    expect(compare("", "").rows).toHaveLength(0)
    expect(
      compare(null, text).rows.flatMap((row) => marks(row.after!.tree))
    ).toEqual([])
    expect(
      compare(text, null).rows.flatMap((row) => marks(row.before!.tree))
    ).toEqual([])
    const inserted = compare("# Title\n\nEnd.", "# Title\n\nNew block.\n\nEnd.")
    expect(inserted.rows[1].changed).toBe(true)
    expect(inserted.rows[1].before).toBeUndefined()
    expect(marks(inserted.rows[1].after!.tree)).toEqual([])
  })
  test("partial replacements highlight whole words, preserving unchanged context", () => {
    const result = compare(
      "# Intro\n\nKeep this 41 value.\n\nEnd",
      "# Intro\n\nKeep this 42 value.\n\nEnd"
    )
    expect(result.rows.map((row) => row.changed)).toEqual([false, true, false])
    expect(marks(result.rows[1].before!.tree)).toEqual(["41"])
    expect(marks(result.rows[1].after!.tree)).toEqual(["42"])
    expect(result.added).toBe(1)
    expect(result.removed).toBe(1)
    const word = compare("This application works.", "This applications works.")
    expect(marks(word.rows[0].before!.tree)).toEqual(["application"])
    expect(marks(word.rows[0].after!.tree)).toEqual(["applications"])
  })
  test("adjacent changed words share their single space without swallowing unchanged words", () => {
    const result = compare(
      "The old small application stays ready.",
      "The new large service stays available."
    )
    expect(marks(result.rows[0].before!.tree)).toEqual([
      "old small application",
      "ready",
    ])
    expect(marks(result.rows[0].after!.tree)).toEqual([
      "new large service",
      "available",
    ])
  })
  test("insertions beside modified blocks do not shift the before/after pairing", () => {
    const before =
      "# Guide\n\n[Reference documentation](old)\n\n```ts\nconst result = 41\n```\n\nExisting old paragraph.\n\nEnd."
    const after =
      "# Guide\n\nNew block.\n\n[Reference documentation](new)\n\n```ts\nconst result = 42\n```\n\nAnother insertion.\n\nExisting new paragraph.\n\nEnd."
    const result = compare(before, after)
    for (const value of ["New block.", "Another insertion."]) {
      const added = result.rows.find((row) => row.after?.text.trim() === value)!
      expect(added.before).toBeUndefined()
      expect(marks(added.after!.tree)).toEqual([])
    }
    const link = result.rows.find(
      (row) => row.after?.text.trim() === "Reference documentation"
    )!
    expect(link.before?.text).toBe(link.after?.text)
    expect(link.detail).toBeTruthy()
    const code = result.rows.find((row) =>
      row.after?.text.includes("const result = 42")
    )!
    expect(marks(code.before!.tree)).toEqual(["41"])
    expect(marks(code.after!.tree)).toEqual(["42"])
    const paragraph = result.rows.find(
      (row) => row.after?.text.trim() === "Existing new paragraph."
    )!
    expect(marks(paragraph.before!.tree)).toEqual(["old"])
    expect(marks(paragraph.after!.tree)).toEqual(["new"])
    const reversed = compare(after, before)
    expect(
      reversed.rows.filter((row) => row.before && !row.after)
    ).toHaveLength(2)
  })
  test("spacing-only changes never produce inline marks", () => {
    for (const [before, after] of [
      ["same words", "same  words"],
      ["same\twords", "same    words"],
      ["same\nwords", "same words"],
      [" ", "\t  \n"],
    ]) {
      expect(changedText(before, after)).toEqual({ removed: [], added: [] })
    }
  })
  test("multiple spaces, tabs and line breaks split changed phrases and remain unmarked", () => {
    for (const separator of ["  ", "   ", "\t", "\t\t", " \t ", "\n"]) {
      const before = `old name${separator}previous value`
      const after = `new title${separator}current result`
      const ranges = changedText(before, after)
      expect(
        ranges.removed.map(({ start, end }) => before.slice(start, end))
      ).toEqual(["old name", "previous value"])
      expect(
        ranges.added.map(({ start, end }) => after.slice(start, end))
      ).toEqual(["new title", "current result"])
    }
  })
  test("graphemes remain intact, including combining accents and joined emoji", () => {
    const a = "Salut 👩🏽‍💻 e\u0301 !",
      b = "Salut 👩🏽‍🚀 é !"
    const ranges = changedText(a, b)
    expect(
      ranges.removed.map((range) => a.slice(range.start, range.end)).join("")
    ).toContain("👩🏽‍💻")
    expect(
      ranges.added.map((range) => b.slice(range.start, range.end)).join("")
    ).toContain("👩🏽‍🚀")
  })
  test("whole parsing preserves multi-line paragraphs, nested lists, tables, quotes and code", () => {
    const before =
      "A line\nand another.\n\n- Parent\n  - Child old\n\n| A | B |\n| - | - |\n| one | old |\n\n> A quote\n\n```ts\nconst n = 41\n```"
    const after = before.replaceAll("old", "new").replace("41", "42")
    const result = compare(before, after)
    expect(tags(result.rows[0].after!.tree)).toContain("br")
    expect(result.rows[0].after!.lines).toEqual({ start: 1, end: 2 })
    expect(
      tags(result.rows[1].after!.tree).filter((tag) => tag === "ul")
    ).toHaveLength(2)
    expect(tags(result.rows[2].after!.tree)).toContain("table")
    expect(marks(result.rows[2].before!.tree)).toEqual(["old"])
    expect(marks(result.rows[2].after!.tree)).toEqual(["new"])
    expect(tags(result.rows[3].after!.tree)).toContain("blockquote")
    expect(tags(result.rows[4].after!.tree)).toContain("pre")
    expect(marks(result.rows[4].after!.tree)).toEqual(["42"])
  })
  test("unchanged blocks keep the correct before and after coordinates", () => {
    const result = compare(
      "# A\n\nRepeated\n\nRepeated\n\n# End",
      "# A\n\nAdded\n\nRepeated\n\nRepeated\n\n# End"
    )
    expect(result.rows.at(-1)?.before?.lines.start).toBe(7)
    expect(result.rows.at(-1)?.after?.lines.start).toBe(9)
    expect(
      result.rows
        .filter((row) => row.after?.text.trim() === "Repeated")
        .map((row) => row.before?.lines.start)
    ).toEqual([3, 5])
  })
  test("formatting, link destinations and image references never appear unchanged", () => {
    for (const [before, after] of [
      ["plain", "**plain**"],
      ["*same*", "_same_"],
      ["[guide](https://example.com/old)", "[guide](https://example.com/new)"],
      ["![alt](old.png)", "![alt](new.png)"],
      [
        "[guide][id]\n\n[id]: https://example.com/old",
        "[guide][id]\n\n[id]: https://example.com/new",
      ],
    ]) {
      const result = compare(before, after)
      expect(result.rows[0].changed).toBe(true)
      expect(result.rows[0].detail).toBeTruthy()
    }
  })
  test("rendered HTML stays sanitized and added blocks need no inline marks", () => {
    const text =
      '# Safe\n\n<script>window.pwned = true</script>\n\n<img src="x" onerror="alert(1)">\n\n[bad](javascript:alert(1))\n\n```html\n<script>inert()</script>\n```'
    const result = compare(null, text)
    const html = result.rows
      .map((row) =>
        renderToStaticMarkup(
          <MarkdownTreeRenderer tree={row.after!.tree} prefix="test-" />
        )
      )
      .join("")
    expect(html).not.toContain("<script>")
    expect(html).not.toContain("onerror")
    expect(html).not.toContain("javascript:")
    expect(html).not.toContain("document-diff-text")
    expect(html).toContain("inert()")
  })
  test("document-wide reference definitions and footnotes resolve", () => {
    const text =
      "See [reference][ref]. Footnote[^one].\n\n[ref]: https://example.com/docs\n\n[^one]: Details."
    const result = compare(null, text)
    const html = result.rows
      .map((row) =>
        renderToStaticMarkup(
          <MarkdownTreeRenderer tree={row.after!.tree} prefix="test-" />
        )
      )
      .join("")
    expect(html).toContain('href="https://example.com/docs"')
    expect(html).toContain("Details.")
    expect(html).toContain('href="#test-fn-one"')
    expect(html).toContain('id="test-fn-one"')
  })
})
