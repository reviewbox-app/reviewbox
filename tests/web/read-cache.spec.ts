import { expect, test } from "@playwright/test"

test("Code Explain restores cached selection and scroll while refreshing, and keeps it on errors", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const state = { reads: 0, captures: 0, fail: false, delay: 0 }
    Object.assign(window, {
      cacheFixture: state,
      isTauri: true,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: { path: string }) => {
          if (command === "code_explain_context") {
            state.captures++
            await new Promise((resolve) => setTimeout(resolve, state.delay))
            if (state.fail) throw new Error("Fixture refresh unavailable")
            return {
              id: `capture-${state.captures}`,
              repositoryId: "cache-fixture",
              changes: [],
              files: ["README.md", "notes.TXT"].map((path) => ({
                path,
                content: { hash: path, size: 1000, mode: "100644" },
              })),
            }
          }
          if (command === "release_code_context") return
          if (command === "read_snapshot_file") {
            state.reads++
            return (
              `# ${args.path}\n\n` +
              Array.from(
                { length: 100 },
                (_, i) => `## Section ${i}\n\nParagraph ${i}\n\n`
              ).join("")
            )
          }
          throw new Error(`Unexpected command ${command}`)
        },
      },
    })
  })
  await page.goto("/dev/read-cache/")
  await page.getByTitle("notes.TXT", { exact: true }).click()
  const pane = page.getByRole("region", { name: "Markdown file", exact: true })
  await expect(
    pane.getByRole("heading", { name: "notes.TXT", exact: true })
  ).toBeVisible()
  await pane.evaluate((root) => {
    root.scrollTop = 700
  })
  await page.getByRole("textbox", { name: "Filter files" }).fill("notes")
  const position = await pane.evaluate((root) => root.scrollTop)
  const reads = await page.evaluate(
    () =>
      (window as unknown as { cacheFixture: { reads: number } }).cacheFixture
        .reads
  )
  await page.getByRole("button", { name: "Toggle Code Explain" }).click()
  await page.evaluate(() => {
    ;(
      window as unknown as { cacheFixture: { delay: number } }
    ).cacheFixture.delay = 1500
  })
  await page.getByRole("button", { name: "Toggle Code Explain" }).click()
  await expect(page.getByText("Updating project files…")).toBeVisible()
  await expect(pane).toBeVisible()
  await expect(page.getByRole("textbox", { name: "Filter files" })).toHaveValue(
    "notes"
  )
  await expect
    .poll(() => pane.evaluate((root) => root.scrollTop))
    .toBeCloseTo(position, 0)
  await expect(page.getByText("Updating project files…")).not.toBeVisible()
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { cacheFixture: { reads: number } }).cacheFixture
          .reads
    )
  ).toBe(reads)
  await page.evaluate(() => {
    ;(
      window as unknown as { cacheFixture: { fail: boolean } }
    ).cacheFixture.fail = true
    window.dispatchEvent(new Event("focus"))
  })
  await expect(page.getByText("Fixture refresh unavailable")).toBeVisible()
  await expect(pane).toBeVisible()
  await expect
    .poll(() => pane.evaluate((root) => root.scrollTop))
    .toBeCloseTo(position, 0)
})
