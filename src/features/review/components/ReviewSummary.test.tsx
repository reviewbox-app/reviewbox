import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { Workspace } from "@/lib/desktop/contracts.generated"
import { ReviewSummary } from "./ReviewSummary"

const workspace = {
  review: {
    id: "review",
    title: "Changes to `checkout`",
    needsUpdateConfirmation: false,
    publication: {
      status: "draft",
      keepLocal: true,
      completion: null,
      matchingCommitIds: [],
    },
    topics: [
      {
        id: "topic",
        title: "**Checkout**",
        brief: "Preserve the cart when **payment fails**.",
        steps: [
          { id: "first", title: "Keep the `cart`" },
          { id: "second", title: "Retry payment" },
          { id: "third", title: "Show the receipt" },
        ],
      },
    ],
    decisions: [
      { target: { kind: "step", stepId: "first" }, state: "validated" },
      { target: { kind: "step", stepId: "second" }, state: "examined" },
    ],
  },
} as unknown as Workspace
const action = () => {}
function render(value = workspace) {
  return renderToStaticMarkup(
    <ReviewSummary
      workspace={value}
      level="explained"
      busy={false}
      onAction={action}
      onHome={action}
      onReturn={action}
    />
  )
}
test("an unfinished summary recaps changes and distinguishes decisions without announcing completion", () => {
  const html = render()
  expect(html).toContain("Review summary")
  expect(html).not.toContain("End of the tour")
  expect(html).not.toContain("Review complete")
  expect(html).toContain("1 of 3 steps validated")
  expect(html).toContain("<strong>payment fails</strong>")
  expect(html).toMatch(/<code[^>]*>cart<\/code>/)
  for (const state of ["Validated", "Examined", "To review"])
    expect(html).toContain(state)
})
test("completion follows the durable review status, not merely the number of validations", () => {
  const allValidated = {
    ...workspace,
    review: {
      ...workspace.review,
      decisions: workspace.review.topics[0].steps.map((step) => ({
        ...workspace.review.decisions[0],
        target: { kind: "step" as const, stepId: step.id },
      })),
    },
  }
  expect(render(allValidated)).not.toContain("Review complete")
  const completed = {
    ...allValidated,
    review: {
      ...allValidated.review,
      publication: {
        ...allValidated.review.publication,
        status: "completedLocal" as const,
      },
    },
  }
  expect(render(completed)).toContain("Review complete")
  expect(render(completed)).toContain("Changes in this review")
})
