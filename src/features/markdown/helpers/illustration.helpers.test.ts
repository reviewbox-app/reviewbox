import { expect, test } from "bun:test"
import {
  illustrationDocument,
  illustrationMessage,
} from "./illustration.helpers"
import { remarkReview } from "../components/remarkReview"

test("illustration bridge allows only bounded presentation and identified references", () => {
  const message = {
    channel: "reviewbox-illustration",
    token: "token",
    type: "resize",
    height: 100000,
  }
  expect(illustrationMessage(message, "token")).toEqual({
    type: "resize",
    height: 2000,
  })
  expect(illustrationMessage(message, "other")).toBeNull()
  expect(
    illustrationMessage(
      { ...message, type: "invoke", command: "read_file" },
      "token"
    )
  ).toBeNull()
  expect(
    illustrationMessage(
      { ...message, type: "reference", id: "../../file" },
      "token"
    )
  ).toBeNull()
  expect(illustrationDocument("<button>Simulate</button>", "token")).toContain(
    "prefers-reduced-motion"
  )
})
test("glossary linking excludes code, existing links and ambiguous terms", () => {
  const term = {
    id: "state",
    term: "state",
    definition: "Current value",
    context: "Component",
  }
  const tree = {
    type: "root",
    children: [
      {
        type: "paragraph",
        children: [
          { type: "text", value: "A state changes." },
          { type: "inlineCode", value: "state" },
          {
            type: "link",
            url: "https://example.com",
            children: [{ type: "text", value: "state" }],
          },
        ],
      },
      { type: "code", value: "state" },
    ],
  }
  remarkReview({ terms: [term] })(tree)
  expect(JSON.stringify(tree).match(/reviewbox:term\/state/g)?.length).toBe(1)
  const ambiguous = {
    type: "root",
    children: [{ type: "text", value: "state" }],
  }
  remarkReview({
    terms: [term, { ...term, id: "workflow", context: "Workflow" }],
  })(ambiguous)
  expect(JSON.stringify(ambiguous)).not.toContain("reviewbox:term")
})
