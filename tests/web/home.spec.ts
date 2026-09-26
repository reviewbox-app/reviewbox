import { test, expect } from "@playwright/test"
test("home renders without hydration errors and handles the desktop boundary", async ({
  page,
}) => {
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.goto("/")
  await expect(
    page.getByRole("heading", { name: "ReviewBox", exact: true })
  ).toBeVisible()
  await page
    .getByRole("button", { name: "Open repository", exact: true })
    .click()
  await expect(
    page.getByRole("alert").filter({ hasText: "Open the desktop app" })
  ).toContainText("Open the desktop app")
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.getByRole("button", { name: "light", exact: true }).click()
  await expect(page.locator("html")).toHaveClass(/light/)
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog")).not.toBeVisible()
  expect(errors).toEqual([])
})
