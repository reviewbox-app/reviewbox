import { expect, test } from "@playwright/test"

test("shared tree appearance, uniformly dimmed folders, filtered statuses and read-only menus", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  await page.goto("/dev/file-tree/")
  const review = page.getByRole("navigation", { name: "Review", exact: true })
  const explain = page.getByRole("navigation", {
    name: "Code Editor",
    exact: true,
  })
  await expect(explain.locator("[data-folder]")).toHaveAttribute(
    "aria-expanded",
    "false"
  )
  await explain.locator("[data-folder]").click()
  for (const theme of ["Light", "Dark"]) {
    await page.getByRole("button", { name: theme, exact: true }).click()
    const values = []
    for (const name of ["Review", "Code Editor", "Local changes"]) {
      const tree = page.getByRole("navigation", { name, exact: true })
      await expect(tree.locator("[data-folder]")).toHaveCSS("opacity", "0.8")
      await expect(tree.locator("[data-folder] [data-git-status]")).toHaveCount(
        0
      )
      await expect(tree.locator("[data-git-status]")).toHaveText([
        "A",
        "D",
        "M",
        "R",
        "U",
      ])
      values.push(
        await tree.locator("[data-git-status]").evaluateAll((nodes) =>
          nodes.map((node) => ({
            color: getComputedStyle(node).color,
            opacity: getComputedStyle(node).opacity,
          }))
        )
      )
    }
    expect(values[0]).toEqual(values[1])
    expect(values[1]).toEqual(values[2])
  }
  await review.locator('[title="src/deleted.ts"]').click({ button: "right" })
  await expect(page.getByRole("menuitem")).toHaveText([
    "Copy path",
    "Reveal in Finder",
  ])
  await expect(page.getByLabel("Selected file", { exact: true })).toHaveText(
    "src/added.ts"
  )
  await page.getByRole("menuitem", { name: "Copy path" }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "src/deleted.ts"
  )
  await review.locator("[data-folder]").focus()
  await page.keyboard.press("Shift+F10")
  await expect(page.getByRole("menuitem")).toHaveText([
    "Copy path",
    "Reveal in Finder",
  ])
  await page.getByRole("menuitem", { name: "Reveal in Finder" }).click()
  await expect(page.getByLabel("Revealed path", { exact: true })).toHaveText(
    "src"
  )
  await page.getByRole("button", { name: "Fail reveal" }).click()
  await explain.locator('[title="src/modified.ts"]').focus()
  await page.keyboard.press("Shift+F10")
  await page.getByRole("menuitem", { name: "Reveal in Finder" }).click()
  await expect(page.locator("main").getByRole("alert")).toHaveText(
    "Finder unavailable"
  )
  await expect(page.getByLabel("Selected file", { exact: true })).toHaveText(
    "src/added.ts"
  )
  const folderColor = await review
    .locator("[data-folder] > span")
    .evaluate((node) => getComputedStyle(node).color)
  await page.getByLabel("Filter fixture files").fill("deleted")
  await expect(review.locator('[title="src/added.ts"]')).toHaveCount(0)
  expect(
    await review
      .locator("[data-folder] > span")
      .evaluate((node) => getComputedStyle(node).color)
  ).toBe(folderColor)
})

test("all rows fade to 80 percent except hovered or selected", async ({
  page,
}) => {
  await page.goto("/dev/file-tree/")
  const review = page.getByRole("navigation", { name: "Review", exact: true })
  const selected = review.locator('[title="src/added.ts"]')
  const file = review.locator('[title="src/modified.ts"]')
  await expect(selected).toHaveCSS("opacity", "1")
  await expect(file).toHaveCSS("opacity", "0.8")
  await file.hover()
  await expect(file).toHaveCSS("opacity", "1")
  await file.click()
  await page.getByRole("button", { name: "Dark", exact: true }).hover()
  await expect(file).toHaveCSS("opacity", "1")
  await expect(selected).toHaveCSS("opacity", "0.8")
  await expect(review.locator('[data-folder="src"]')).toHaveCSS(
    "opacity",
    "0.8"
  )
})
