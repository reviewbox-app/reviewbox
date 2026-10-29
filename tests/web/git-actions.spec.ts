import { expect, test } from "@playwright/test"

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __TAURI_INTERNALS__: unknown
      calls: string[]
      releaseFetch: () => void
      releaseStage: () => void
      failFirst: boolean
    }
    Object.assign(window, { isTauri: true })
    w.calls = []
    const state = (repositoryId = "fixture") => ({
      repositoryId,
      files: ["src/one.ts", "src/two.ts"].map((path) => ({
        path,
        version: path,
        unstagedStatus: "M",
        stagedStatus: null,
        conflicted: false,
      })),
    })
    w.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke: async (
        command: string,
        args: { repositoryId?: string; files?: { path: string }[] }
      ) => {
        if (command === "local_git_state") return state(args.repositoryId)
        if (command === "fetch_git_remote") {
          w.calls.push("fetch")
          await new Promise<void>((resolve) => {
            w.releaseFetch = resolve
          })
          return state(args.repositoryId)
        }
        if (command === "stage_local_files") {
          w.calls.push(args.files![0].path)
          await new Promise<void>((resolve) => {
            w.releaseStage = resolve
          })
          if (w.failFirst && args.files![0].path === "src/one.ts")
            throw { code: "stale_file", message: "File changed before staging" }
          return state(args.repositoryId)
        }
        if (command === "editor_watch_status") return { healthy: true }
        return 1
      },
    }
  })
})
test("focus refresh stays quiet and stages clicked in succession execute once in order", async ({
  page,
}) => {
  await page.goto("/dev/git-actions/")
  await expect(page.locator("p[role=status]")).toHaveText("Ready")
  const first = page.getByRole("button", {
    name: "Stage file src/one.ts",
    exact: true,
  })
  const second = page.getByRole("button", {
    name: "Stage file src/two.ts",
    exact: true,
  })
  await page.locator('button[title="src/one.ts"]').hover()
  await first.click()
  await expect(page.locator("p[role=status]")).toHaveText("Working")
  await page.locator('button[title="src/two.ts"]').hover()
  await second.click()
  expect(
    await page.evaluate(() => (window as unknown as { calls: string[] }).calls)
  ).toEqual(["fetch"])
  await page.evaluate(() =>
    (window as unknown as { releaseFetch: () => void }).releaseFetch()
  )
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { calls: string[] }).calls)
    )
    .toEqual(["fetch", "src/one.ts"])
  await page.evaluate(() =>
    (window as unknown as { releaseStage: () => void }).releaseStage()
  )
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { calls: string[] }).calls)
    )
    .toEqual(["fetch", "src/one.ts", "src/two.ts"])
  await page.evaluate(() =>
    (window as unknown as { releaseStage: () => void }).releaseStage()
  )
  await expect(page.locator("p[role=status]")).toHaveText("Ready")
  await expect(page.locator("button button")).toHaveCount(0)
  await expect(page.locator("output")).toHaveText("")
})
test("a queued action is cancelled when its project is replaced", async ({
  page,
}) => {
  await page.goto("/dev/git-actions/")
  await page.locator('button[title="src/one.ts"]').hover()
  await page
    .getByRole("button", { name: "Stage file src/one.ts", exact: true })
    .click()
  // Release the old fetch after the hook owner changes.
  await page.evaluate(() => {
    ;(
      window as unknown as { oldRelease: unknown; releaseFetch: unknown }
    ).oldRelease = (window as unknown as { releaseFetch: unknown }).releaseFetch
  })
  await page.getByRole("button", { name: "Switch project" }).click()
  await page.evaluate(() =>
    (window as unknown as { oldRelease: () => void }).oldRelease()
  )
  expect(
    await page.evaluate(() => (window as unknown as { calls: string[] }).calls)
  ).not.toContain("src/one.ts")
})

test("grouped title aligns icon and count; tree actions remain sibling controls", async ({
  page,
}) => {
  await page.goto("/dev/git-actions/")
  const folder = page.locator("[data-folder=src]")
  await expect(folder).toBeVisible()
  const geometry = await folder.evaluate((el) => {
    const title = el.querySelector(".font-medium")!.getBoundingClientRect()
    const count = el.querySelector("[data-row-meta]")!.getBoundingClientRect()
    const path = el.querySelector("[title=src]")!.getBoundingClientRect()
    return {
      titleX: title.x,
      pathX: path.x + 46,
      titleY: title.y + title.height / 2,
      countY: count.y + count.height / 2,
      pathY: path.y,
    }
  })
  expect(Math.abs(geometry.titleY - geometry.countY)).toBeLessThan(2)
  expect(Math.abs(geometry.titleX - geometry.pathX)).toBeLessThan(2)
  expect(geometry.pathY).toBeGreaterThan(geometry.titleY)
  await folder.hover()
  await expect(folder.locator("[data-row-meta]")).toHaveCSS(
    "visibility",
    "hidden"
  )
  const plus = page.getByRole("button", {
    name: "Stage folder src",
    exact: true,
  })
  await expect(plus).toHaveCSS("opacity", "1")
  await page.getByRole("button", { name: "Toggle layout" }).click()
  await page.locator("[data-folder=src]").click()
  await page.locator('button[title="src/one.ts"]').hover()
  await expect(
    page.locator('button[title="src/one.ts"] [data-git-status]')
  ).toHaveCSS("visibility", "hidden")
  await expect(page.locator("button button")).toHaveCount(0)
})

test("a failed queued write does not drop the following action or hide the error", async ({
  page,
}) => {
  await page.goto("/dev/git-actions/")
  await page.evaluate(() => {
    ;(window as unknown as { failFirst: boolean }).failFirst = true
  })
  await page.locator('button[title="src/one.ts"]').hover()
  await page
    .getByRole("button", { name: "Stage file src/one.ts", exact: true })
    .click()
  await page.locator('button[title="src/two.ts"]').hover()
  await page
    .getByRole("button", { name: "Stage file src/two.ts", exact: true })
    .click()
  await page.evaluate(() =>
    (window as unknown as { releaseFetch: () => void }).releaseFetch()
  )
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { calls: string[] }).calls.length
      )
    )
    .toBe(2)
  await page.evaluate(() =>
    (window as unknown as { releaseStage: () => void }).releaseStage()
  )
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { calls: string[] }).calls)
    )
    .toEqual(["fetch", "src/one.ts", "src/two.ts"])
  await page.evaluate(() =>
    (window as unknown as { releaseStage: () => void }).releaseStage()
  )
  await expect(page.locator("p[role=status]")).toHaveText("Ready")
  await expect(
    page.getByText("File changed before staging", { exact: true })
  ).toBeVisible()
})
