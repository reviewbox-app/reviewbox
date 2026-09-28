import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type {
  ReadingLevel,
  ReviewDocument,
} from "@/lib/desktop/contracts.generated"
import { ReviewMarkdown } from "./ReviewMarkdown"
function render(
  body: string,
  level: ReadingLevel = "intermediate",
  extra: Partial<ReviewDocument> = {}
) {
  return renderToStaticMarkup(
    <ReviewMarkdown
      document={{
        body,
        references: [],
        terms: [],
        termAliases: {},
        readingSeconds: 10,
        ...extra,
      }}
      level={level}
      reviewId="review"
      snapshotId="snapshot"
      files={[]}
    />
  )
}
describe("review documents", () => {
  test("only source references may render real code; intermediate never falls back", () => {
    const html = render(
      "```typescript\nconst secret = 42\n```\n\n```source\nmissing\n```"
    )
    expect(html).not.toContain("const secret")
    expect(html).toContain("captured reference is unavailable")
    expect(
      render("```source\nknown\n```", "intermediate", {
        references: [
          {
            id: "known",
            label: "Function",
            explanation: "Behavior",
            sourceId: "change:a:after",
            startLine: 1,
            endLine: 2,
          },
        ],
      })
    ).toContain("Loading the captured reference")
  })
  test("beginner supports pseudo-code while keeping diagram source hidden", () => {
    const html = render(
      '```pseudocode\nRETURN 42\n```\n\n```mermaid\ngraph TD; A-->B\n```\n\n```before-after\n{"before":["One attempt"],"after":["Two attempts"]}\n```',
      "beginner"
    )
    expect(html).toContain("RETURN")
    expect(html).not.toContain("A--&gt;B")
    expect(html).toContain("One attempt")
    expect(html).toContain("Two attempts")
  })
  test("enriched blocks stay inert and malformed blocks fail explicitly", () => {
    const html = render(
      '```before-after\n{"before":["<script>bad()</script>"],"after":[]}\n```\n\n```before-after\n{}\n```\n\n<script>run()</script>\n\n[bad](javascript:run())'
    )
    expect(html).not.toContain("<script>")
    expect(html).not.toContain("javascript:")
    expect(html).toContain("&lt;script&gt;")
    expect(html).toContain("comparison is unavailable")
  })
  test("summary blocks preserve the reading level restrictions", () => {
    const body =
      "````summary\nA short summary.\n\n```typescript\nconst privateValue = 42\n```\n\n```pseudocode\nRETURN privateValue\n```\n````"
    const beginner = render(body, "beginner")
    const intermediate = render(body, "intermediate")
    expect(beginner).toContain("A short summary")
    expect(beginner).not.toContain("const privateValue")
    expect(beginner).toContain("RETURN")
    expect(intermediate).not.toContain("const privateValue")
    expect(intermediate).toContain("RETURN")
  })
  test("controlled references become keyboard accessible controls, never external links", () => {
    const html = render(
      "[Value](reviewbox:ref/value) and [Term](reviewbox:term/term)",
      "developer",
      {
        references: [
          {
            id: "value",
            label: "Value",
            explanation: "A captured constant",
            sourceId: "change:a:after",
            startLine: 1,
            endLine: 1,
          },
        ],
        terms: [
          {
            id: "term",
            term: "Term",
            definition: "Definition",
            context: "Here",
          },
        ],
      }
    )
    expect(html).toContain("<button")
    expect(html).toContain("Value")
    expect(html).not.toContain('href="reviewbox:')
  })
})
