import { expect, test } from "@playwright/test"

test("Code Editor shares Markdown defaults, text toggle, search and positions", async ({
  page,
}) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto("/dev/knowledge-file/")
  const pane = page.getByRole("region", { name: "Markdown file", exact: true })
  const toggle = page.getByRole("button", { name: "Markdown preview" })
  await expect(
    pane.getByRole("heading", { name: "Captured guide" })
  ).toBeVisible()
  await expect(
    pane.locator(
      "[data-change=added], [data-change=removed], .document-diff-label"
    )
  ).toHaveCount(0)
  await expect(toggle).toHaveAttribute("aria-pressed", "true")
  await page.getByRole("button", { name: "Find in file" }).click()
  await page
    .getByRole("textbox", { name: "Find in document" })
    .fill("Needle outcome")
  await expect(page.getByRole("search").getByRole("status")).toHaveText("1 / 1")
  await page.getByRole("button", { name: "Close document search" }).click()
  await pane.evaluate((root) => {
    const target = Array.from(root.querySelectorAll("h2")).find(
      (node) => node.textContent === "Section 40"
    )!
    root.scrollTop +=
      target.getBoundingClientRect().top - root.getBoundingClientRect().top - 40
  })
  const scroll = await pane.evaluate((root) => root.scrollTop)
  await toggle.focus()
  await page.keyboard.press("Enter")
  await expect(page.locator(".monaco-editor")).toHaveCount(1)
  await expect
    .poll(async () =>
      (await page.locator(".view-lines").innerText()).replaceAll("\u00a0", " ")
    )
    .toContain("Section 40")
  const position = await page
    .locator(".view-lines")
    .evaluate((e) => e.getBoundingClientRect().top)
  const tick = Number(await page.getByTestId("refresh-count").textContent())
  await expect
    .poll(async () =>
      Number(await page.getByTestId("refresh-count").textContent())
    )
    .toBeGreaterThan(tick + 2)
  expect(
    await page
      .locator(".view-lines")
      .evaluate((e) => e.getBoundingClientRect().top)
  ).toBe(position)
  await page.getByRole("button", { name: "notes.TXT", exact: true }).click()
  await expect(pane.getByRole("heading", { name: "Notes" })).toBeVisible()
  await expect(pane.locator("br")).toHaveCount(1)
  await page.getByRole("button", { name: "README.md", exact: true }).click()
  await expect(toggle).toHaveAttribute("aria-pressed", "false")
  await expect
    .poll(async () =>
      (await page.locator(".view-lines").innerText()).replaceAll("\u00a0", " ")
    )
    .toContain("Section 40")
  await toggle.click()
  await expect
    .poll(async () =>
      Math.abs((await pane.evaluate((root) => root.scrollTop)) - scroll)
    )
    .toBeLessThan(100)
  await page.getByRole("button", { name: "LICENSE", exact: true }).click()
  await expect(
    pane.getByRole("heading", { name: "Captured guide" })
  ).toBeVisible()
  for (const path of ["CMakeLists.txt", "README.mdx"]) {
    await page.getByRole("button", { name: path, exact: true }).click()
    await expect(toggle).toHaveCount(0)
    await expect(page.locator(".monaco-editor")).toHaveCount(1)
  }
  expect(errors).toEqual([])
})

test("a failed Code Editor preview can return to raw text", async ({
  page,
}) => {
  await page.route("**/monaco/document-diff.worker.js", (route) =>
    route.abort()
  )
  await page.goto("/dev/knowledge-file/")
  const alert = page
    .getByRole("region", { name: "Markdown file", exact: true })
    .getByRole("alert")
  await expect(alert).toContainText("Markdown preview could not be loaded")
  await alert.getByRole("button", { name: "Open in code" }).click()
  await expect(page.locator(".monaco-editor")).toHaveCount(1)
  await expect(
    page.getByRole("button", { name: "Markdown preview" })
  ).toHaveAttribute("aria-pressed", "false")
})
