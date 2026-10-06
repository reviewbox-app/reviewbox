import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MarkdownRenderer } from "./MarkdownRenderer"

const terms = [
  { id: "term", term: "value", definition: "Named data", context: "A value" },
]
test("source spans retain exact positions across Unicode, emphasis, repeated words and glossary links", () => {
  const source =
    "😀 **bold** [value](reviewbox:term/term)\n\nvalue again `file.ts`"
  const html = renderToStaticMarkup(
    <MarkdownRenderer
      selectable
      allowHtml={false}
      glossary={terms}
      renderLink={(_, children) => <button>{children}</button>}
    >
      {source}
    </MarkdownRenderer>
  )
  const spans = [
    ...html.matchAll(
      /data-document-start="(\d+)" data-document-end="(\d+)"[^>]*>([^<]*)<\/span>/g
    ),
  ]
  expect(spans.length).toBeGreaterThan(4)
  const values = spans.map((match) =>
    source.slice(Number(match[1]), Number(match[2]))
  )
  expect(values).toContain("bold")
  expect(values.filter((value) => value === "value")).toHaveLength(2)
  expect(values).toContain("😀 ")
  expect(values).toContain("file.ts")
})
test("ordinary Markdown does not acquire selection controls or source offsets", () => {
  expect(
    renderToStaticMarkup(<MarkdownRenderer>Plain text</MarkdownRenderer>)
  ).not.toContain("data-document-start")
})
