import { expect, test } from "@playwright/test"

test("rapid source/preview switches dispose Monaco without errors", async ({
  page,
}) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto("/dev/document-diff/")
  const toggle = page.getByRole("button", { name: "Markdown preview" })
  await expect(toggle).toBeEnabled()
  for (let i = 0; i < 5; i++) {
    await toggle.click()
    await toggle.click()
  }
  await page
    .getByRole("button", { name: "CMakeLists.txt", exact: true })
    .click()
  await page.getByRole("button", { name: "README.md", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: "Captured guide" })
  ).toBeVisible()
  expect(errors).toEqual([])
})

test("a failed preview explains the error and still opens the source", async ({
  page,
}) => {
  await page.route("**/monaco/document-diff.worker.js", (route) =>
    route.abort()
  )
  await page.goto("/dev/document-diff/")
  const error = page
    .getByRole("region", { name: "Markdown file diff" })
    .getByRole("alert")
  await expect(error).toContainText("Markdown preview could not be loaded")
  await error.getByRole("button", { name: "Open in code" }).click()
  await expect(page.locator(".block-diff-main > .monaco-editor")).toBeVisible()
})

test("switching files cancels an obsolete preview and keeps text line breaks", async ({
  page,
}) => {
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route("**/monaco/document-diff.worker.js", async (route) => {
    await gate
    await route.continue().catch(() => {})
  })
  await page.goto("/dev/document-diff/")
  await expect(page.getByText("Rendering Markdown…")).toBeVisible()
  await page.getByRole("button", { name: "notes.TXT", exact: true }).click()
  release?.()
  const pane = page.getByRole("region", { name: "Markdown file diff" })
  await expect(pane.locator('[data-change="added"]')).toContainText(
    "Notes after"
  )
  await expect(pane.locator("br")).toHaveCount(2)
  await expect(
    pane.getByRole("heading", { name: "Captured guide" })
  ).toHaveCount(0)
})

test("document preview, structured diffs, layouts, rendered search and theme colors", async ({
  page,
}) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto("/dev/document-diff/")
  const pane = page.getByRole("region", { name: "Markdown file diff" })
  await expect(
    pane.getByRole("heading", { name: "Captured guide" })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Markdown preview" })
  ).toHaveAttribute("aria-pressed", "true")
  await expect(
    page.getByRole("button", { name: "Display options" })
  ).toHaveCount(0)
  await expect(pane.locator("table")).toHaveCount(2)
  await expect(pane.locator("table mark")).toHaveText([
    "3",
    "Private application data",
    "4",
    "Local only",
  ])
  await expect(pane.locator("ul ul")).toHaveCount(2)
  await expect(pane.locator("ul mark")).toHaveText([
    "old value",
    "fresh content",
  ])
  const addedBlock = pane.locator(".document-diff-block").filter({
    hasText: "A newly added paragraph needs no inline highlight.",
  })
  await expect(addedBlock).toHaveAttribute("data-change", "added")
  await expect(addedBlock.locator("mark")).toHaveCount(0)
  await expect(pane.getByText("End of captured document.")).toHaveCount(1)
  await expect(pane.getByText("Formatting, link or image changed")).toHaveCount(
    2
  )
  await expect(pane.locator(".markdown-code mark").last()).toHaveText("42")
  const unifiedWidth = await pane
    .locator(".document-diff-row")
    .first()
    .evaluate((row) => {
      const box = row.getBoundingClientRect(),
        container = row.parentElement!.getBoundingClientRect()
      return {
        width: box.width,
        centerOffset: Math.abs(
          (box.left + box.right - container.left - container.right) / 2
        ),
      }
    })
  expect(unifiedWidth.width).toBeLessThanOrEqual(720)
  expect(unifiedWidth.centerOffset).toBeLessThan(10)
  await page.getByRole("tab", { name: "Split", exact: true }).click()
  await expect(
    pane.getByRole("heading", { name: "Captured guide" })
  ).toHaveCount(2)
  const alignment = await pane
    .locator(".document-diff-row")
    .first()
    .evaluate((row) =>
      Array.from(row.children).map(
        (element) => element.getBoundingClientRect().top
      )
    )
  expect(alignment[0]).toBe(alignment[1])
  for (const theme of ["Light", "Dark"]) {
    await page.getByRole("button", { name: theme, exact: true }).click()
    const colors = await pane
      .locator('[data-change="added"]')
      .first()
      .evaluate((block) => ({
        block: getComputedStyle(block).backgroundColor,
        mark: getComputedStyle(block.querySelector("mark")!).backgroundColor,
      }))
    expect(colors.block).not.toBe("rgba(0, 0, 0, 0)")
    expect(colors.mark).not.toBe(colors.block)
  }
  await page.getByRole("button", { name: "Find in file" }).click()
  await page
    .getByRole("textbox", { name: "Find in document" })
    .fill("Needle outcome")
  await expect(page.getByRole("search").getByRole("status")).toHaveText("1 / 2")
  await page.getByRole("button", { name: "Next match" }).click()
  await expect(page.getByRole("search").getByRole("status")).toHaveText("2 / 2")
  await page
    .getByRole("textbox", { name: "Find in document" })
    .fill("https://example.com/new")
  await expect(page.getByRole("search").getByRole("status")).toHaveText("0 / 0")
  await page.getByRole("button", { name: "Close document search" }).click()
  expect(errors).toEqual([])
})

test("keyboard toggles preserve source passage, session preferences and passive refresh scroll", async ({
  page,
}) => {
  await page.goto("/dev/document-diff/")
  const pane = page.getByRole("region", { name: "Markdown file diff" })
  await expect(
    pane.getByRole("heading", { name: "Section 40", exact: true })
  ).toHaveCount(1)
  await pane.evaluate((root) => {
    const target = Array.from(root.querySelectorAll("h2")).find(
      (node) => node.textContent === "Section 40"
    )!
    root.scrollTop +=
      target.getBoundingClientRect().top - root.getBoundingClientRect().top - 80
  })
  const scroll = await pane.evaluate((root) => root.scrollTop)
  const tick = Number(await page.getByTestId("refresh-count").textContent())
  await expect
    .poll(async () =>
      Number(await page.getByTestId("refresh-count").textContent())
    )
    .toBeGreaterThan(tick + 2)
  expect(await pane.evaluate((root) => root.scrollTop)).toBe(scroll)
  const toggle = page.getByRole("button", { name: "Markdown preview" })
  await toggle.focus()
  await page.keyboard.press("Enter")
  await expect(toggle).toHaveAttribute("aria-pressed", "false")
  await expect(page.locator(".block-diff-main > .monaco-editor")).toBeVisible()
  await expect
    .poll(async () =>
      (
        await page
          .locator(
            ".block-diff-main > .monaco-editor > .overflow-guard > .monaco-scrollable-element > .lines-content > .view-lines"
          )
          .innerText()
      ).replaceAll("\u00a0", " ")
    )
    .toContain("Section 40")
  await toggle.focus()
  await page.keyboard.press("Space")
  await expect(pane).toBeVisible()
  await expect
    .poll(async () =>
      Math.abs((await pane.evaluate((root) => root.scrollTop)) - scroll)
    )
    .toBeLessThan(100)
  await toggle.click()
  await page.getByRole("button", { name: "LICENSE", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Markdown preview" })
  ).toHaveAttribute("aria-pressed", "true")
  await page.getByRole("button", { name: "README.md", exact: true }).click()
  await expect(toggle).toHaveAttribute("aria-pressed", "false")
  await page
    .getByRole("button", { name: "CMakeLists.txt", exact: true })
    .click()
  await expect(toggle).toHaveCount(0)
  await page.getByRole("button", { name: "README.mdx", exact: true }).click()
  await expect(toggle).toHaveCount(0)
})

test("explicit references open raw source and repeatedly center the captured range", async ({
  page,
}) => {
  await page.goto("/dev/document-diff/")
  await expect(
    page.getByRole("region", { name: "Markdown file diff" })
  ).toBeVisible()
  const open = page.getByRole("button", { name: "Open in code", exact: true })
  for (let i = 0; i < 2; i++) {
    await open.click()
    await expect(
      page.getByRole("button", { name: "Markdown preview" })
    ).toHaveAttribute("aria-pressed", "false")
    await expect
      .poll(async () =>
        page
          .locator(
            ".block-diff-main > .monaco-editor .view-overlays .review-passage"
          )
          .first()
          .evaluate((element) => {
            const pane = element
                .closest('[aria-label="Code diff"]')!
                .getBoundingClientRect(),
              mark = element.getBoundingClientRect()
            return Math.abs(
              (mark.top + mark.bottom) / 2 -
                (pane.top + 56 + pane.bottom - 36) / 2
            )
          })
      )
      .toBeLessThan(60)
    await page.getByRole("button", { name: "Markdown preview" }).click()
    await expect(
      page.getByRole("region", { name: "Markdown file diff" })
    ).toBeVisible()
  }
})

for (const file of ["NEW.md", "DELETED.md"]) {
  test(`${file}: regular views retain position and center explicit source references`, async ({
    page,
  }) => {
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.goto("/dev/document-diff/")
    await page.getByRole("tab", { name: "Split", exact: true }).click()
    await page.getByRole("button", { name: file, exact: true }).click()
    const pane = page.getByRole("region", {
      name: "Markdown file",
      exact: true,
    })
    await expect(
      pane.getByRole("heading", { name: "Captured guide" })
    ).toBeVisible()
    await expect(
      page.getByRole("tab", { name: "Split", exact: true })
    ).toHaveCount(0)
    await expect(
      pane.locator(
        '.document-diff-label, [data-change="added"], [data-change="removed"], mark'
      )
    ).toHaveCount(0)
    await pane.evaluate((root) => {
      const target = Array.from(root.querySelectorAll("h2")).find(
        (node) => node.textContent === "Section 40"
      )!
      root.scrollTop +=
        target.getBoundingClientRect().top -
        root.getBoundingClientRect().top -
        80
    })
    const scroll = await pane.evaluate((root) => root.scrollTop)
    const toggle = page.getByRole("button", { name: "Markdown preview" })
    await toggle.click()
    await expect(page.locator(".monaco-editor")).toHaveCount(1)
    await expect(page.locator(".monaco-diff-editor")).toHaveCount(0)
    await expect
      .poll(async () =>
        (await page.locator(".view-lines").innerText()).replaceAll(
          "\u00a0",
          " "
        )
      )
      .toContain("Section 40")
    const tick = Number(await page.getByTestId("refresh-count").textContent())
    const offset = await page
      .locator(".view-lines")
      .evaluate((e) => e.getBoundingClientRect().top)
    await expect
      .poll(async () =>
        Number(await page.getByTestId("refresh-count").textContent())
      )
      .toBeGreaterThan(tick + 2)
    expect(
      await page
        .locator(".view-lines")
        .evaluate((e) => e.getBoundingClientRect().top)
    ).toBe(offset)
    await toggle.click()
    await expect
      .poll(async () =>
        Math.abs((await pane.evaluate((root) => root.scrollTop)) - scroll)
      )
      .toBeLessThan(100)
    for (let i = 0; i < 2; i++) {
      await page
        .getByRole("button", { name: "Open in code", exact: true })
        .click()
      await expect(toggle).toHaveAttribute("aria-pressed", "false")
      const mark = page.locator(".view-overlays .review-passage").first()
      await expect(mark).toBeVisible()
      await expect
        .poll(async () =>
          mark.evaluate((element) => {
            const pane = element
                .closest('[aria-label="Code diff"]')!
                .getBoundingClientRect(),
              box = element.getBoundingClientRect()
            return Math.abs(
              (box.top + box.bottom) / 2 -
                (pane.top + 56 + pane.bottom - 36) / 2
            )
          })
        )
        .toBeLessThan(60)
      await toggle.click()
      await expect(pane).toBeVisible()
    }
    await page.getByRole("button", { name: "README.md", exact: true }).click()
    await expect(
      page.getByRole("tab", { name: "Split", exact: true })
    ).toHaveAttribute("aria-selected", "true")
    expect(errors).toEqual([])
  })
}
