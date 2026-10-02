import { expect, test } from "@playwright/test"

test("block comparisons keep unchanged code single, exact models and one scroll", async ({
  page,
}) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto("/dev/document-diff/")
  await page.getByRole("button", { name: "blocks.ts", exact: true }).click()
  const root = page.locator(".block-diff")
  await expect(
    page.getByRole("button", { name: "Hide previous code", exact: true })
  ).toHaveAttribute("aria-pressed", "true")
  await page
    .getByRole("button", { name: "Hide previous code", exact: true })
    .click()
  await expect(root.locator(".block-diff-main > .monaco-editor")).toBeVisible()
  await expect(
    page.getByRole("tab", { name: "Unified", exact: true })
  ).toHaveCount(0)
  await expect(root.locator(".block-deletion button").first()).toBeVisible()
  await expect(root.locator(".block-comparison")).toHaveCount(0)
  const surfaces = await root
    .locator(".block-added, .block-added-margin")
    .evaluateAll((nodes) =>
      nodes.map((node) => getComputedStyle(node).backgroundColor)
    )
  expect(surfaces.length).toBeGreaterThan(1)
  expect(new Set(surfaces).size).toBe(1)
  for (const [theme, color] of [
    ["Light", "rgb(237, 247, 239)"],
    ["Dark", "rgb(38, 51, 43)"],
  ]) {
    await page.getByRole("button", { name: theme, exact: true }).click()
    await expect
      .poll(() =>
        root
          .locator(".block-added")
          .first()
          .evaluate((n) => getComputedStyle(n).backgroundColor)
      )
      .toBe(color)
    await expect
      .poll(() =>
        root
          .locator(".block-added-margin")
          .first()
          .evaluate((n) => getComputedStyle(n).backgroundColor)
      )
      .toBe(color)
  }

  await page
    .getByRole("button", { name: "Show previous code", exact: true })
    .click()
  await expect(
    page.getByRole("button", { name: "Hide previous code", exact: true })
  ).toHaveAttribute("aria-pressed", "true")
  await expect(
    root
      .locator(".block-comparison .block-after .view-lines")
      .filter({ hasText: "currentOnlyValue" })
  ).toBeVisible()
  const block = root
    .locator(".block-comparison")
    .filter({ hasText: "currentOnlyValue" })
  await expect(block.locator(".block-before .view-lines")).toContainText(
    "previousOnlyValue"
  )
  await expect(
    block.locator(".block-word-after").filter({ hasText: "currentOnlyValue" })
  ).toBeVisible()
  await expect(
    block.locator(".block-word-before").filter({ hasText: "previousOnlyValue" })
  ).toBeVisible()
  await expect(
    block.locator(".block-word-after").filter({ hasText: "const mode" })
  ).toHaveCount(0)
  const color = await block
    .locator(".block-word-after")
    .first()
    .evaluate((e) => getComputedStyle(e).backgroundColor)
  expect(color).not.toBe("rgba(0, 0, 0, 0)")
  const boxes = await block.locator(".block-column").evaluateAll((nodes) =>
    nodes.map((node) => {
      const r = node.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })
  )
  expect(boxes[0].x).toBeLessThan(boxes[1].x)
  expect(boxes[0].height).toBe(boxes[1].height)
  expect(boxes[0].width).toBeGreaterThan(100)
  const outside = root.locator(
    ".block-diff-main > .monaco-editor > .overflow-guard > .monaco-scrollable-element > .lines-content > .view-lines"
  )
  await expect(outside).not.toContainText("currentOnlyValue")
  const alignment = async () => {
    const current = block.locator(".block-after")
    const mainNumbers = root
      .locator(
        ".block-diff-main > .monaco-editor > .overflow-guard > .margin .line-numbers"
      )
      .first()
    const blockNumbers = current.locator(".line-numbers:visible").first()
    const mainCode = await outside.boundingBox()
    const blockCode = await current.locator(".view-lines").boundingBox()
    const mainGutter = await mainNumbers.boundingBox()
    const blockGutter = await blockNumbers.boundingBox()
    expect(blockCode!.x).toBeCloseTo(mainCode!.x, 1)
    expect(blockGutter!.x + blockGutter!.width).toBeCloseTo(
      mainGutter!.x + mainGutter!.width,
      1
    )
  }
  await alignment()

  await page.screenshot({ path: "artifacts/playwright/block-comparison.png" })
  await page.getByRole("button", { name: "Find in file", exact: true }).click()
  await page
    .getByRole("textbox", { name: "Find in file", exact: true })
    .fill("previousOnlyValue")
  await expect(page.getByRole("search")).toContainText("1/1")
  await page.getByRole("button", { name: "Close search", exact: true }).click()
  await page.setViewportSize({ width: 800, height: 700 })
  await expect(block.locator(".block-before .monaco-editor")).toBeVisible()
  const narrow = await block
    .locator(".block-column")
    .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().y))
  expect(narrow[0]).toBe(narrow[1])
  await alignment()
  await page
    .getByRole("button", { name: "Hide previous code", exact: true })
    .click()
  await expect(root.locator(".block-comparison")).toHaveCount(0)
  await page.getByRole("button", { name: "Find in file", exact: true }).click()
  await page
    .getByRole("textbox", { name: "Find in file", exact: true })
    .fill("previousOnlyValue")
  await expect(page.getByRole("search")).toContainText("0 results")
  await page.getByRole("button", { name: "Close search", exact: true }).click()
  await page.getByRole("button", { name: "NEW.md", exact: true }).click()
  await expect(root).toHaveCount(0)
  await page.getByRole("button", { name: "blocks.ts", exact: true }).click()
  await expect(root).toBeVisible()
  expect(errors).toEqual([])
})

test("deletion marker opens previous content without duplicating the file", async ({
  page,
}) => {
  await page.goto("/dev/document-diff/")
  await page.getByRole("button", { name: "blocks.ts", exact: true }).click()
  const root = page.locator(".block-diff")
  await expect(
    page.getByRole("button", { name: "Hide previous code", exact: true })
  ).toHaveAttribute("aria-pressed", "true")
  await page
    .getByRole("button", { name: "Hide previous code", exact: true })
    .click()
  await root.locator(".block-deletion button").first().click()
  await expect(
    root
      .locator(".block-before .view-lines")
      .filter({ hasText: "previous-only heading" })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Hide previous code", exact: true })
  ).toBeVisible()
})

test("old references open their exact block and passive refresh preserves the viewport", async ({
  page,
}) => {
  await page.goto("/dev/document-diff/")
  await page.getByRole("button", { name: "blocks.ts", exact: true }).click()
  await page
    .getByRole("button", { name: "Open old block", exact: true })
    .click()
  await expect(
    page.getByRole("button", { name: "Hide previous code", exact: true })
  ).toBeVisible()
  const mark = page.locator(".block-before .review-passage").first()
  await expect(mark).toBeVisible()
  const point = await mark.evaluate((e) => e.getBoundingClientRect().top)
  const tick = Number(await page.getByTestId("refresh-count").textContent())
  await expect
    .poll(async () =>
      Number(await page.getByTestId("refresh-count").textContent())
    )
    .toBeGreaterThan(tick + 2)
  expect(await mark.evaluate((e) => e.getBoundingClientRect().top)).toBe(point)
})

test("a whole-file replacement keeps secondary viewports bounded and searches near the end", async ({
  page,
}) => {
  await page.goto("/dev/document-diff/")
  await page
    .getByRole("button", { name: "large-block.ts", exact: true })
    .click()
  await expect(
    page.getByRole("button", { name: "Hide previous code", exact: true })
  ).toHaveAttribute("aria-pressed", "true")
  const root = page.locator(".block-diff")
  await expect(root.locator(".block-after .view-lines")).toContainText("after0")
  const heights = await root
    .locator(".block-cell > .monaco-editor")
    .evaluateAll((nodes) => nodes.map((n) => n.getBoundingClientRect().height))
  expect(heights.length).toBe(2)
  expect(Math.max(...heights)).toBeLessThan(1500)
  await page.getByRole("button", { name: "Find in file", exact: true }).click()
  await page
    .getByRole("textbox", { name: "Find in file", exact: true })
    .fill("old580")
  await expect(page.getByRole("search")).toContainText("1/1")
  await expect(root.locator(".block-before .view-lines")).toContainText(
    "before580"
  )
  await page.getByRole("button", { name: "Close search", exact: true }).click()
  await page
    .getByRole("button", { name: "Hide previous code", exact: true })
    .click()
  await expect(root.locator(".block-comparison")).toHaveCount(0)
})

test("search reaches an old deletion outside the mounted viewport", async ({
  page,
}) => {
  await page.goto("/dev/document-diff/")
  await page.getByRole("button", { name: "blocks.ts", exact: true }).click()
  await expect(page.locator(".block-before .view-lines").first()).toBeVisible()
  await page.getByRole("button", { name: "Find in file", exact: true }).click()
  await page
    .getByRole("textbox", { name: "Find in file", exact: true })
    .fill("previous-only ending")
  await expect(page.getByRole("search")).toContainText("1/1")
  const old = page
    .locator(".block-before .view-lines")
    .filter({ hasText: "previous-only ending" })
  await expect(old).toBeVisible()
  const box = await old.boundingBox()
  expect(box!.y).toBeGreaterThan(0)
  expect(box!.y).toBeLessThan(850)
})
