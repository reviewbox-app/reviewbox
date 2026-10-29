import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ReviewCommit } from "./ReviewCommit"

function render(hasChanges?: boolean) {
  return renderToStaticMarkup(
    <ReviewCommit
      repositoryId="repo"
      reviewId="review"
      hasChanges={hasChanges}
      onFinish={() => {}}
    />
  )
}
test("a clean checkout offers finishing the review without a misleading commit action", () => {
  const html = render(false)
  expect(html).toContain("Finish review")
  expect(html).toContain("Your working tree is clean")
  expect(html).not.toContain("Stage &amp; commit with Rev")
})
test("finish stays left of commit when saved changes remain", () => {
  const html = render(true)
  expect(html.indexOf("Finish review")).toBeLessThan(
    html.indexOf("Stage &amp; commit with Rev")
  )
  expect(html).not.toContain("disabled=")
})
test("unknown Git state cannot start staging", () => {
  expect(render()).toContain("disabled=")
})
