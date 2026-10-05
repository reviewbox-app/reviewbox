import { expect, test } from "@playwright/test"

test.beforeEach(async ({ page }) => {
  await page.goto("/dev/editor-chrome/")
  await expect(
    page.getByRole("button", { name: "Create file or folder" })
  ).toBeVisible()
})

test("file search opens results, excludes ignored files and restores folder state", async ({
  page,
}) => {
  const tree = page.getByRole("navigation", { name: "Project files" })
  const search = page.getByRole("textbox", {
    name: /Filter files|Search file contents/,
  })
  await tree.locator('[data-folder="docs"]').click()
  await expect(tree.locator('[data-folder="docs"]')).toHaveAttribute(
    "aria-expanded",
    "true"
  )
  await expect(tree.locator('[data-folder="src"]')).toHaveAttribute(
    "aria-expanded",
    "false"
  )
  await search.fill("example")
  await expect(tree.locator('button[title="src/example.ts"]')).toBeVisible()
  await expect(tree.locator('[data-folder="src"]')).not.toHaveAttribute(
    "aria-expanded"
  )
  await search.fill("ignored")
  await expect(tree.getByRole("status")).toContainText("0 files")
  await expect(tree.locator('button[title="ignored.txt"]')).toHaveCount(0)
  await search.fill("")
  await expect(tree.locator('[data-folder="src"]')).toHaveAttribute(
    "aria-expanded",
    "false"
  )
  await expect(tree.locator('[data-folder="docs"]')).toHaveAttribute(
    "aria-expanded",
    "true"
  )
  await expect(tree.locator('button[title="ignored.txt"]')).toBeVisible()
  await expect(page.getByTestId("content-search-requests")).toHaveText("[]")
})

test("content search debounces, cancels stale requests and opens matching source", async ({
  page,
}) => {
  const search = page.getByRole("textbox", {
    name: /Filter files|Search file contents/,
  })
  await search.fill("slow")
  await page.getByRole("tab", { name: "Content", exact: true }).click()
  await expect(page.getByTestId("content-search-requests")).toContainText(
    "slow"
  )
  await search.fill("need")
  await search.fill("needle")
  const results = page.getByLabel("Content search results", { exact: true })
  await expect(results.getByRole("status")).toContainText(
    "3 matches in 2 files"
  )
  await expect(results).not.toContainText("ignored.txt")
  await expect(page.getByTestId("content-search-requests")).toHaveText(
    '["slow","needle"]'
  )
  await expect(page.getByTestId("content-search-cancelled")).toHaveText("1")
  // The cancelled fixture deliberately resolves later; it must never replace results.
  await expect
    .poll(async () => {
      await new Promise((resolve) => setTimeout(resolve, 800))
      return results.getByRole("status").textContent()
    })
    .toContain("3 matches in 2 files")
  await results
    .getByRole("button", { name: "docs/guide.md:2:1 needle one", exact: true })
    .click()
  await expect(
    page.getByRole("tab", { name: "docs/guide.md", exact: true })
  ).toHaveAttribute("aria-selected", "true")
  await expect(
    page.getByRole("button", { name: "Markdown preview" })
  ).toHaveAttribute("aria-pressed", "false")
  await expect(page.locator(".monaco-editor")).toHaveCount(1, {
    timeout: 30000,
  })
  const selection = page.locator(".monaco-editor .selected-text").first()
  await expect(selection).toBeVisible()
  const firstSelectionY = await selection.evaluate(
    (element) => element.getBoundingClientRect().y
  )
  await results
    .getByRole("button", { name: "docs/guide.md:3:1 needle two", exact: true })
    .click()
  await expect(
    page.getByRole("tab", { name: "docs/guide.md", exact: true })
  ).toHaveAttribute("aria-selected", "true")
  await expect
    .poll(() =>
      selection.evaluate((element) => element.getBoundingClientRect().y)
    )
    .toBeGreaterThan(firstSelectionY)
  await page.screenshot({
    path: "artifacts/playwright/editor-content-search.png",
  })
  await search.fill("")
  await expect(results).toHaveCount(0)
  await expect(
    page
      .getByRole("navigation", { name: "Project files" })
      .locator('[data-folder="docs"]')
  ).toHaveAttribute("aria-expanded", "false")
})

test("inventory polling neither cancels in-flight content search nor clears completed results", async ({
  page,
}) => {
  await page.goto("/dev/editor-chrome/?poll=1")
  const search = page.getByRole("textbox", {
    name: /Filter files|Search file contents/,
  })
  await expect(search).toBeVisible()
  await search.fill("slow")
  await page.getByRole("tab", { name: "Content", exact: true }).click()
  const results = page.getByLabel("Content search results", { exact: true })
  await expect(results.getByRole("status")).toHaveText("0 matches in 0 files")
  await expect
    .poll(async () =>
      Number(await page.getByTestId("inventory-ticks").textContent())
    )
    .toBeGreaterThanOrEqual(8)
  await expect(page.getByTestId("content-search-requests")).toHaveText(
    '["slow"]'
  )
  await expect(page.getByTestId("content-search-cancelled")).toHaveText("0")
  await search.fill("needle")
  await expect(results.getByRole("status")).toHaveText("3 matches in 2 files")
  const ticks = Number(await page.getByTestId("inventory-ticks").textContent())
  await expect
    .poll(async () =>
      Number(await page.getByTestId("inventory-ticks").textContent())
    )
    .toBeGreaterThanOrEqual(ticks + 6)
  await expect(results.getByRole("status")).toHaveText("3 matches in 2 files")
  await expect(page.getByTestId("content-search-requests")).toHaveText(
    '["slow","needle"]'
  )
  await page
    .getByRole("button", { name: "Refresh content search", exact: true })
    .click()
  await expect(page.getByTestId("content-search-requests")).toHaveText(
    '["slow","needle","needle"]'
  )
  await expect(results.getByRole("status")).toHaveText("3 matches in 2 files")
})
