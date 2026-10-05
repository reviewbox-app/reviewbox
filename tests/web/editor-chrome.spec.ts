import { expect, test } from "@playwright/test"

test("editor actions are compact and creation leads both context menus", async ({
  page,
}) => {
  await page.goto("/dev/editor-chrome/")
  await expect(
    page.getByRole("button", { name: "Create file or folder" })
  ).toBeVisible()
  await expect(
    page.getByRole("checkbox", { name: "Show ignored files" })
  ).toHaveCount(0)
  await expect(page.getByRole("checkbox", { name: "Auto save" })).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "Save all", exact: true })
  ).toHaveCount(0)
  await expect(
    page.locator('button[title="ignored.txt"] > span').first()
  ).toHaveCSS("opacity", "0.6")
  await page.getByRole("button", { name: "Create file or folder" }).click()
  await expect(page.getByRole("menuitem")).toHaveText([
    "New file",
    "New folder",
  ])
  await page.getByRole("menuitem", { name: "New file", exact: true }).click()
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  for (const selector of [
    '[data-folder="src"]',
    'button[title="ignored.txt"]',
  ]) {
    await page.locator(selector).click({ button: "right" })
    await expect(page.getByRole("menuitem")).toHaveText([
      "New file",
      "New folder",
      "Copy path",
      "Reveal in Finder",
      "Rename",
      "Move to Trash",
    ])
    for (const name of ["New file", "New folder", "Rename", "Move to Trash"])
      await expect(
        page.getByRole("menuitem", { name, exact: true }).locator("svg")
      ).toHaveCount(1)
    await page.keyboard.press("Escape")
  }
})

test("editor tabs retain dirty state, keyboard navigation and close actions", async ({
  page,
}) => {
  await page.goto("/dev/editor-chrome/")
  await expect(
    page.getByRole("button", { name: "Create file or folder" })
  ).toBeVisible()
  const preview = page.getByRole("region", { name: "Tab design preview" })
  const first = preview.getByRole("tab", {
    name: "TestComponents.tsx",
    exact: true,
  })
  const second = preview.getByRole("tab", {
    name: "notes.md (unsaved)",
    exact: true,
  })
  await expect(first).toHaveAttribute("aria-selected", "true")
  await expect(first.locator("img")).toBeVisible()
  await expect(first.locator("img")).toHaveJSProperty("complete", true)
  await preview.evaluate((element) => {
    element.style.width = "200px"
  })
  const strip = preview.getByRole("tablist")
  await strip.hover()
  await page.mouse.wheel(0, 120)
  await expect
    .poll(() => strip.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0)
  await page.mouse.wheel(0, -1000)
  await expect
    .poll(() => strip.evaluate((element) => element.scrollLeft))
    .toBe(0)
  await preview.evaluate((element) => {
    element.style.width = ""
  })
  await first.focus()
  await page.keyboard.press("ArrowRight")
  await expect(second).toBeFocused()
  await expect(second).toHaveAttribute("aria-selected", "true")
  expect(
    await first.locator("..").evaluate((e) => e.getBoundingClientRect().height)
  ).toBe(28)
  await preview
    .getByRole("button", { name: "Close notes.md", exact: true })
    .click()
  await expect(second).toHaveCount(0)
  await expect(first).toHaveAttribute("aria-selected", "true")
  await page.screenshot({ path: "artifacts/playwright/editor-chrome.png" })
})

test("whole tabs select, overlay close stays separate and dragging preserves selection", async ({
  page,
}) => {
  await page.goto("/dev/editor-chrome/")
  await expect(
    page.getByRole("button", { name: "Create file or folder" })
  ).toBeVisible()
  const preview = page.getByRole("region", { name: "Tab design preview" })
  const first = preview.getByRole("tab", {
    name: "TestComponents.tsx",
    exact: true,
  })
  const second = preview.getByRole("tab", {
    name: "notes.md (unsaved)",
    exact: true,
  })
  await second.click({ position: { x: 8, y: 2 } })
  await expect(second).toHaveAttribute("aria-selected", "true")
  await first.click({ position: { x: 8, y: 2 } })
  await expect(first).toHaveAttribute("aria-selected", "true")
  const close = preview.getByRole("button", {
    name: "Close notes.md",
    exact: true,
  })
  await expect(close).toHaveCSS("opacity", "0")
  await expect(second.locator("button")).toHaveCount(0)
  await second.hover()
  await expect(close).toHaveCSS("opacity", "1")
  await expect(close).toHaveCSS("position", "absolute")
  await expect(close).toHaveCSS("backdrop-filter", "blur(12px)")
  const source = await second.boundingBox()
  const target = await first.boundingBox()
  if (!source || !target) throw new Error("Tabs are not visible")
  await page.mouse.move(source.x + 10, source.y + source.height / 2)
  await page.mouse.down()
  await page.mouse.move(target.x + 10, target.y + target.height / 2, {
    steps: 12,
  })
  await page.mouse.up()
  await expect(preview.getByRole("tab").first()).toHaveAttribute(
    "title",
    "notes.md"
  )
  await expect(first).toHaveAttribute("aria-selected", "true")
  await second.hover()
  await close.click()
  await expect(second).toHaveCount(0)
  await expect(first).toHaveAttribute("aria-selected", "true")
})

test("tabs reorder with the keyboard and Escape cancels without changing selection", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/dev/editor-chrome/")
  await expect(
    page.getByRole("button", { name: "Create file or folder" })
  ).toBeVisible()
  const preview = page.getByRole("region", { name: "Tab design preview" })
  const first = preview.getByRole("tab", {
    name: "TestComponents.tsx",
    exact: true,
  })
  const second = preview.getByRole("tab", {
    name: "notes.md (unsaved)",
    exact: true,
  })
  await first.focus()
  await page.keyboard.press("Space")
  await expect(first).toHaveAttribute("aria-pressed", "true")
  // Collision measurement completes after the sensor activation render.
  await expect(preview.getByRole("status")).toHaveText(
    "Draggable item TestComponents.tsx was moved over droppable area TestComponents.tsx."
  )
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      })
  )
  await page.keyboard.press("ArrowRight")
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "was moved over droppable area notes.md." })
  ).toHaveCount(1)
  await page.keyboard.press("Escape")
  await expect(
    page.getByRole("status").filter({ hasText: "Dragging was cancelled." })
  ).toHaveCount(1)
  await expect(first).not.toHaveAttribute("aria-pressed", "true")
  await expect(preview.getByRole("tab").first()).toHaveAttribute(
    "title",
    "TestComponents.tsx"
  )
  await expect(first).toHaveAttribute("aria-selected", "true")
  await first.focus()
  await page.keyboard.press("Space")
  await expect(first).toHaveAttribute("aria-pressed", "true")
  // Collision measurement completes after the sensor activation render.
  await expect(preview.getByRole("status")).toHaveText(
    "Draggable item TestComponents.tsx was moved over droppable area TestComponents.tsx."
  )
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      })
  )
  await page.keyboard.press("ArrowRight")
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "was moved over droppable area notes.md." })
  ).toHaveCount(1)
  await page.keyboard.press("Space", { delay: 50 })
  await expect(preview.getByRole("tab").first()).toHaveAttribute(
    "title",
    "notes.md"
  )
  await expect(first).toHaveAttribute("aria-selected", "true")
  await expect(second).toHaveAttribute("aria-selected", "false")
})
