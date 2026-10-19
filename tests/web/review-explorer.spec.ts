import { expect, test } from "@playwright/test"

test("review shares File/Content controls, searches captured sides and opens exact selections read-only", async ({
  page,
}) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto("/dev/review-explorer/")
  const search = page.getByRole("textbox", {
    name: /Filter files|Search file contents/,
  })
  await search.fill("needle")
  await page.getByRole("tab", { name: "Content", exact: true }).click()
  const results = page.getByLabel("Content search results", { exact: true })
  await expect(results.getByRole("status")).toHaveText("3 matches in 2 files")
  await expect(results).toContainText("Captured review files")
  await results
    .getByRole("button", { name: /src\/deep\/colors.ts:2:10 const oldNeedle/ })
    .click()
  await expect(
    page.locator(".block-comparison .selected-text").first()
  ).toBeVisible()
  await results
    .getByRole("button", { name: /docs\/deleted.md:2:9 Deleted needle/ })
    .click()
  await expect(
    page.locator(".monaco-editor .selected-text").first()
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Markdown preview" })
  ).toHaveAttribute("aria-pressed", "false")
  await page.keyboard.type("cannot change captured source")
  await expect(page.locator(".view-lines")).not.toContainText(
    "cannot change captured source"
  )
  expect(errors).toEqual([])
})

test("captured code shares color highlights and Git change gutters", async ({
  page,
}) => {
  await page.goto("/dev/review-explorer/")
  const editor = page.locator(".block-diff-main > .monaco-editor")
  await expect(editor).toBeVisible()
  await expect(page.locator('[class*="rb-color-"]').first()).toBeVisible()
  await page
    .getByRole("button", { name: "Hide previous code", exact: true })
    .click()
  await expect(
    editor.locator(".reviewbox-change-modified").first()
  ).toBeVisible()
})

test("selected review text opens find from its shortcut and context menu", async ({
  page,
}) => {
  await page.goto("/dev/review-explorer/")
  await page
    .getByRole("button", { name: "Hide previous code", exact: true })
    .click()
  const editor = page.locator(".block-diff-main > .monaco-editor")
  await expect(editor).toBeVisible()
  await editor
    .locator(".view-line")
    .filter({ hasText: "const color" })
    .first()
    .click()
  await page.keyboard.press("Home")
  await page.keyboard.press("Shift+End")
  await expect(editor.locator(".selected-text").first()).toBeVisible()
  await page.keyboard.press("ControlOrMeta+Shift+f")
  await expect(
    page.getByRole("textbox", { name: "Find in file", exact: true })
  ).toHaveValue(/.+/)
  await page.keyboard.press("Escape")
  await editor
    .locator(".view-line")
    .filter({ hasText: "const color" })
    .first()
    .click()
  await page.keyboard.press("Home")
  await page.keyboard.press("Shift+End")
  await editor
    .locator(".view-line")
    .filter({ hasText: "const color" })
    .first()
    .click({ button: "right", position: { x: 40, y: 8 } })
  await expect(
    page.getByRole("menuitem", { name: /Search selection/ })
  ).toBeVisible()
  // Monaco enables menu mouseup after 100 ms to reject the opening click.
  await page
    .getByRole("menuitem", { name: /Search selection/ })
    .click({ delay: 150 })

  await expect(
    page.getByRole("textbox", { name: "Find in file", exact: true })
  ).toHaveValue(/.+/)
})
