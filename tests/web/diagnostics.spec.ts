import { expect, test } from "@playwright/test"

test.beforeEach(async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  await page.addInitScript(() => {
    const entries: {
      id: string
      timestamp: string
      sessionId: string
      appVersion: string
      platform: string
      error: unknown
    }[] = []
    const state = { fail: false, revealed: false, entries }
    Object.assign(window, {
      diagnosticFixture: state,
      isTauri: true,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        unregisterCallback: () => {},
        invoke: async (
          command: string,
          args: { input: unknown; diagnosticId?: string }
        ) => {
          if (command.startsWith("plugin:event|")) return 1
          if (command === "editor_profiles") return []
          if (command === "appearance_settings")
            return {
              revision: 0,
              codeTheme: "tokyo-night",
              fileIcons: {
                activeIconPack: "default",
                fileAssociations: {},
                folderAssociations: {},
                fileClones: [],
                folderClones: [],
              },
              importedProfile: null,
              importWarnings: [],
            }
          if (state.fail) throw new Error("Fixture log storage unavailable")
          if (command === "diagnostics_record") {
            const existing = entries.find(
              (e) =>
                e.id === args.diagnosticId ||
                JSON.stringify(e.error) === JSON.stringify(args.input)
            )
            if (existing) return existing
            const entry = {
              id: `fixture-error-${entries.length + 1}`,
              timestamp: "1790935200000",
              sessionId: "fixture-session",
              appVersion: "0.1.0",
              platform: "fixture",
              error: args.input,
            }
            entries.unshift(entry)
            return entry
          }
          if (command === "diagnostics_read")
            return { directory: "/fixture/app-data/logs", entries }
          if (command === "diagnostics_reveal") {
            state.revealed = true
            return
          }
          throw new Error(`Unexpected fixture command: ${command}`)
        },
      },
    })
  })
})

test("Rev copies actionable details and Settings exposes the private error log", async ({
  page,
}) => {
  await page.goto("/dev/diagnostics/")
  const alert = page
    .getByRole("alert")
    .filter({ hasText: "Codex could not complete" })
  const copy = page.getByRole("button", {
    name: "Copy error details",
    exact: true,
  })
  await expect(alert).toBeVisible()
  expect((await copy.boundingBox())!.y).toBeGreaterThan(
    (await alert.boundingBox())!.y
  )
  await copy.click()
  await expect(
    page.getByRole("button", { name: "Copied", exact: true })
  ).toBeVisible()
  const report = await page.evaluate(() => navigator.clipboard.readText())
  expect(report).toContain("Error ID: fixture-error-1")
  expect(report).toContain("HTTP 403")
  expect(report).toContain("reviewId: fixture-review")
  expect(report).not.toContain("fixture-private-token")
  await page.screenshot({ path: "/tmp/reviewbox-diagnostics-review.png" })
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByRole("button", { name: "Error log", exact: true }).click()
  await expect(
    dialog.getByText("/fixture/app-data/logs", { exact: true })
  ).toBeVisible()
  await dialog.locator("summary").click()
  await expect(dialog.locator("pre")).toContainText("HTTP 403")
  await dialog
    .getByRole("button", { name: "Copy recent errors", exact: true })
    .click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(report)
  await dialog
    .getByRole("button", { name: "Reveal in Finder", exact: true })
    .click()
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { diagnosticFixture: { revealed: boolean } })
          .diagnosticFixture.revealed
    )
  ).toBe(true)
  await page.screenshot({ path: "/tmp/reviewbox-diagnostics-settings.png" })
  await page.evaluate(() =>
    window.dispatchEvent(
      new ErrorEvent("error", { error: new Error("Runtime fixture failure") })
    )
  )
  await dialog.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(dialog.locator("summary").first()).toContainText(
    "Runtime fixture failure"
  )
})

test("clipboard denial exposes selectable details without claiming success", async ({
  page,
}) => {
  await page.goto("/dev/diagnostics/")
  await page.evaluate(() =>
    Object.defineProperty(navigator.clipboard, "writeText", {
      value: async () => {
        throw new DOMException("Denied", "NotAllowedError")
      },
    })
  )
  await page
    .getByRole("button", { name: "Copy error details", exact: true })
    .click()
  await expect(
    page.getByRole("alert").filter({ hasText: "Copy failed" })
  ).toBeVisible()
  await expect(page.locator("pre")).toContainText("HTTP 403")
  await expect(
    page.getByRole("button", { name: "Copied", exact: true })
  ).toHaveCount(0)
})

test("an unavailable log still allows copying the redacted in-memory error", async ({
  page,
}) => {
  await page.addInitScript(() => {
    ;(
      window as unknown as { diagnosticFixture: { fail: boolean } }
    ).diagnosticFixture.fail = true
  })
  await page.goto("/dev/diagnostics/")
  await page
    .getByRole("button", { name: "Copy error details", exact: true })
    .click()
  const report = await page.evaluate(() => navigator.clipboard.readText())
  expect(report).toContain("HTTP 403")
  expect(report).not.toContain("fixture-private-token")
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  await page.getByRole("button", { name: "Error log", exact: true }).click()
  await expect(page.getByRole("dialog").getByRole("alert")).toHaveText(
    "Fixture log storage unavailable"
  )
})
