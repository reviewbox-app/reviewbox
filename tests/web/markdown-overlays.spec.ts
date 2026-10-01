import { expect, test } from "@playwright/test"

for (const [label, title] of [
  ["Snapshot", "Snapshot"],
  ["Embedded definition", "Snapshot"],
]) {
  test(`${label} dialog survives periodic document updates`, async ({
    page,
  }) => {
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.goto("/dev/overlays/")
    const reader = page.getByTestId("live-review-document")
    await reader.getByRole("button", { name: label, exact: true }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()
    const before = Number(
      await page.getByTestId("document-refresh-count").textContent()
    )
    await expect
      .poll(async () =>
        Number(await page.getByTestId("document-refresh-count").textContent())
      )
      .toBeGreaterThanOrEqual(before + 3)
    await expect(dialog).toBeVisible()
    await expect(
      dialog.getByRole("heading", { name: title, exact: true })
    ).toBeVisible()
    if (title === "Snapshot") {
      const revision = await page
        .getByTestId("document-refresh-count")
        .textContent()
      await expect(dialog).toContainText(
        `Definition context at update ${revision}.`
      )
    }
    await page.keyboard.press("Escape")
    await expect(dialog).not.toBeVisible()
    expect(errors).toEqual([])
  })
}

test("a glossary hovercard survives the same background updates", async ({
  page,
}) => {
  await page.goto("/dev/overlays/")
  await page
    .getByTestId("live-review-document")
    .getByRole("button", { name: "Snapshot", exact: true })
    .hover()
  const card = page.locator('[data-slot="hover-card-content"]')
  await expect(card).toBeVisible()
  const before = Number(
    await page.getByTestId("document-refresh-count").textContent()
  )
  await expect
    .poll(async () =>
      Number(await page.getByTestId("document-refresh-count").textContent())
    )
    .toBeGreaterThanOrEqual(before + 3)
  await expect(card).toBeVisible()
})

test("reference cards stay lightweight and accessible across background updates", async ({
  page,
}) => {
  await page.goto("/dev/overlays/")
  const reference = page
    .getByTestId("live-review-document")
    .getByRole("button", { name: "Captured behavior", exact: true })
  await reference.focus()
  const card = page.locator('[data-slot="hover-card-content"]')
  await expect(card).toBeVisible()
  await expect(card).not.toContainText("Loading")
  await expect(card.locator("pre")).toHaveCount(0)
  await reference.click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  const before = Number(
    await page.getByTestId("document-refresh-count").textContent()
  )
  await expect
    .poll(async () =>
      Number(await page.getByTestId("document-refresh-count").textContent())
    )
    .toBeGreaterThanOrEqual(before + 3)
  await expect(card).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(card).not.toBeVisible()
})

test("reference button can be reached and activated from the keyboard", async ({
  page,
}) => {
  await page.goto("/dev/overlays/")
  const reference = page
    .getByTestId("live-review-document")
    .getByRole("button", { name: "Captured behavior", exact: true })
  await reference.focus()
  const button = page
    .locator('[data-slot="hover-card-content"]')
    .getByRole("button", { name: "Open in code" })
  await expect(button).toBeVisible()
  await page.keyboard.press("Tab")
  await expect(button).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(page.getByTestId("opened-source")).not.toBeEmpty()
  await expect(
    page.locator('[data-slot="hover-card-content"]')
  ).not.toBeVisible()
})
