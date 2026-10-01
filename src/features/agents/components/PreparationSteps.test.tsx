import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type {
  PreparationState,
  PreparationStep,
} from "@/lib/desktop/contracts.generated"
import { PreparationSteps } from "./PreparationSteps"

const steps: PreparationStep[] = [
  { id: "first", title: "The **new** behavior", status: "ready" },
  { id: "second", title: "Handle `loading`", status: "writing" },
  { id: "third", title: "Check references", status: "checking" },
  { id: "fourth", title: "Waiting", status: "queued" },
]
const render = (status: PreparationState["status"]) =>
  renderToStaticMarkup(<PreparationSteps steps={steps} status={status} />)
test("completed documents are opaque while queued, writing and checking rows remain pending", () => {
  const html = render("running")
  expect(html).toContain('data-state="ready"')
  expect(html).toContain('data-state="writing"')
  expect(html).toContain('data-state="checking"')
  expect(html).toContain('data-state="queued"')
  expect(html).toContain("opacity-100")
  expect(html).toContain("opacity-60")
  expect(html).toContain("1 of 4 steps ready")
  expect(html).toContain("<strong>new</strong>")
  expect(html).toContain("Waiting for writing")
})
test("cancellation stops pending indicators and never downgrades a ready document", () => {
  for (const status of ["cancelled", "interrupted", "failed"] as const) {
    const html = render(status)
    expect(html).toContain('data-state="ready"')
    expect(html).not.toContain('data-state="writing"')
    expect(html).not.toContain('data-state="checking"')
    expect(
      html.match(
        new RegExp(
          `data-state="${status === "failed" ? "failed" : "interrupted"}"`,
          "g"
        )
      )
    ).toHaveLength(3)
  }
})
test("no fabricated steps before the first complete definition", () => {
  expect(
    renderToStaticMarkup(<PreparationSteps steps={[]} status="running" />)
  ).toBe("")
})
