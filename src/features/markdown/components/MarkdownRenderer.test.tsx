import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MarkdownRenderer } from "./MarkdownRenderer"

function render(markdown: string, allowHtml = true) {
  return renderToStaticMarkup(
    <MarkdownRenderer allowHtml={allowHtml}>{markdown}</MarkdownRenderer>
  )
}

describe("MarkdownRenderer", () => {
  test("renders GFM tables, tasks, footnotes, strike-through and line breaks", () => {
    const html = render(
      "# Title\n\nFirst line\nSecond line\n\n- [x] Done\n- [ ] Pending\n\n| Name | Value |\n| --- | --- |\n| Test | **42** |\n\n~~Removed~~ and a note[^1].\n\n[^1]: Source"
    )
    expect(html).toContain("<h1>Title</h1>")
    expect(html).toContain("<br/>")
    expect(html).toContain("<table>")
    expect(html).toContain("<strong>42</strong>")
    expect(html).toContain('type="checkbox"')
    expect(html).toContain("checked")
    expect(html).toContain("<del>Removed</del>")
    expect(html).toContain("data-footnotes")
    for (const [, target] of html.matchAll(/href="#([^"]+)"/g)) {
      expect(html).toContain(`id="${target}"`)
    }
  })

  test("sanitizes embedded HTML without losing benign formatting or highlighted code", () => {
    const html = render(
      '<details><summary>More</summary><b>Safe</b></details>\n\n<script>alert(1)</script><img src="x" onerror="alert(1)"><a href="javascript:alert(1)">bad</a>\n\n```js\nconst value = "text"\n```'
    )
    expect(html).toContain("<details>")
    expect(html).toContain("<b>Safe</b>")
    expect(html).not.toContain("<script")
    expect(html).not.toContain("onerror")
    expect(html).not.toContain("javascript:")
    expect(html).toContain('data-language="javascript"')
    expect(html).toContain('aria-label="Copy code"')
  })

  test("supports disabling HTML, inline code and unknown code languages", () => {
    const html = render(
      "<b>Hidden markup</b>\n\n`inline`\n\n```unknown-language\n<literal>\n```",
      false
    )
    expect(html).not.toContain("<b>")
    expect(html).toContain("<code>inline</code>")
    expect(html).toContain("&lt;literal&gt;")
    expect(html.match(/aria-label="Copy code"/g)).toHaveLength(1)
  })

  test("keeps Mermaid source available while the client renderer loads", () => {
    const html = render("```mermaid\ngraph TD\nA --> B\n```")
    expect(html).toContain("Rendering diagram")
    expect(html).toContain("A --&gt; B")
    expect(html).not.toContain('aria-label="Mermaid diagram"')
  })
})
