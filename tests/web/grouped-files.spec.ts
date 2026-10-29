import { expect, test } from "@playwright/test"

test("adaptive groups preserve selection, paths and boundaries across filtering and staging", async ({
  page,
}) => {
  await page.goto("/dev/grouped-files/")
  const groups = page.locator("[data-file-group]")
  await expect(groups).toHaveCount(5)
  const original = await groups.evaluateAll((nodes) =>
    nodes.map((n) => n.getAttribute("data-file-group"))
  )
  await page
    .locator('button[title="src/features/review/components/ReviewHeader.tsx"]')
    .click()
  await expect(page.locator("h2")).toHaveText("ReviewHeader.tsx")
  await page
    .getByRole("button", { name: "Stage sample file", exact: true })
    .click()
  expect(
    await groups.evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute("data-file-group"))
    )
  ).toEqual(original)
  await page.getByRole("textbox", { name: "Filter files" }).fill("ReviewHeader")
  await expect(groups).toHaveCount(1)
  await expect(groups.first()).toHaveAttribute(
    "data-file-group",
    "src/features/review"
  )
  await page.getByRole("textbox", { name: "Filter files" }).fill("")
  await page.getByRole("tab", { name: "Tree", exact: true }).click()
  await expect(page.locator('[aria-current="page"]')).toHaveAttribute(
    "title",
    "src/features/review/components/ReviewHeader.tsx"
  )
  await page.getByRole("tab", { name: "Grouped", exact: true }).click()
  const toggle = page.locator(
    '[data-file-group="src/features/review"] > button'
  )
  await toggle.focus()
  await page.keyboard.press("Enter")
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  await page.getByRole("button", { name: "Switch theme" }).click()
  for (const layout of ["Monorepo", "Mixed layout", "Large change"]) {
    await page
      .getByRole("combobox", { name: "Project layout" })
      .selectOption(layout)
    await expect(groups.first()).toBeVisible()
  }
})
