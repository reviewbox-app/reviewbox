import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { NativeUI, fixture } from "../tests/native/ui-driver"
import { createPreparationHarness } from "../tests/native/preparation-fixture"

// Product interactions use the actual Tauri WebView. The default harness is a
// deterministic protocol subprocess; --live uses installed Codex on this fixture.
const live = process.argv.includes("--live")
const selection = process.argv.includes("--selection")
const f = await fixture()
if (selection) {
  await f.write(
    "skip-notes.md",
    "# Release notes\nDocument the behavior and describe the available settings.\n"
  )
  await f.write(
    "skip-settings.json",
    JSON.stringify(
      Object.fromEntries(
        Array.from({ length: 120 }, (_, i) => [
          `displayOption${i}`,
          i % 2 === 0,
        ])
      ),
      null,
      2
    )
  )
  await f.write(
    "skip-types.ts",
    "export interface DisplaySettings { theme: 'light' | 'dark'; title: string }\nexport type SettingId = string;\n"
  )
  await f.write(
    "src/answer.ts",
    "export const answer = 43;\nexport function totalEligible(values: number[], minimum: number) {\n  let total = 0;\n  for (const value of values) {\n    if (value < minimum) continue;\n    total += value;\n  }\n  return total;\n}\n"
  )
}
const ui = new NativeUI()
const { mode, calls, executable } = await createPreparationHarness(f.root, live)
const history = '[aria-label="Preparation activity history"]'
async function waitReady() {
  await ui.wait(
    async () => {
      const error = await ui.execute<string>(
        'return document.querySelector("[data-testid=preparing-review] [role=alert]")?.textContent ?? ""'
      )
      assert(!error, error)
      return (await ui.text()).includes("Your review is ready")
    },
    "complete three-level review",
    live ? 900000 : 60000
  )
}
try {
  await ui.start(join(f.root, "appdata"))
  await ui.named("Settings")
  await ui.wait(
    async () =>
      (await ui.request<string[]>(ui.route("/window/handles"))).includes(
        "settings"
      ),
    "settings"
  )
  await ui.request(ui.route("/window"), { handle: "settings" })
  await ui.named("Rev", "nav button")
  await ui.setHarnessExecutable("codex", executable)
  await ui.setDefaultHarness("codex")
  await ui.request(ui.route("/window"), { handle: "main" })
  await ui.named("or enter a path")
  await ui.fill('[aria-label="Repository path"]', f.repo)
  await ui.named("Open")
  await ui.reviewScope()
  await ui.nextReviewStep()
  await ui.named("With Rev", "label", false)
  await ui.named("Start review", "[role=dialog] footer button")
  await ui.until(
    '!!document.querySelector("[data-testid=preparation-progress]")'
  )
  if (live && process.argv.includes("--exercise-cancel")) {
    await ui.until(
      `!!document.querySelector('[aria-label="Active preparation batches"]')`,
      "live coordinator work"
    )
    await Bun.sleep(2000)
    await ui.named("Cancel", "[data-testid=preparing-review] button", false)
    await ui.has("Preparation stopped. The review files are kept.")
    await ui.named("Resume preparation")
  }
  if (!live) {
    await ui.has("Progress note 11")
    await ui.has("The new amount")
    assert(
      await ui.execute(`return !!document.querySelector('${history} strong')`)
    )
    await ui.until(
      `!document.querySelector('[aria-label="Elapsed time"]').textContent.startsWith('0:00')`
    )
    await ui.named("Continue browsing")
    await ui.until('!document.querySelector("[data-testid=preparing-review]")')
    await ui.named("Review", '[role="tab"]')
    await ui.has("Progress note 11")
    assert.equal(
      (await readFile(calls, "utf8"))
        .split("\n")
        .filter((kind) => kind === "outline").length,
      1,
      "navigation does not restart the native job"
    )
    await ui.execute(
      `const e=document.querySelector('${history}');e.scrollTop=0;e.dispatchEvent(new Event('scroll'));return true`
    )
    await writeFile(mode, "more")
    await ui.has("Additional activity")
    assert.equal(
      await ui.execute(`return document.querySelector('${history}').scrollTop`),
      0,
      "activity preserves manual scroll"
    )
    await ui.screenshot("progress-running")
    await ui.named("Cancel", "[data-testid=preparing-review] button", false)
    await ui.has("Preparation stopped. The review files are kept.")
    assert(await ui.execute(`return !!document.querySelector('${history}')`))
    await writeFile(mode, "error")
    await ui.named("Resume preparation")
    await ui.has("Rev could not finish")
    await ui.until(
      '!!document.querySelector("[data-testid=preparing-review] [role=alert]")'
    )
    await writeFile(mode, "draft")
    await ui.named("Resume preparation")
    await ui.has("Preparing suggestions")
    assert(
      !(await ui.text()).includes("Your review is ready"),
      "partial JSON is never published"
    )
    await ui.screenshot("progress-draft")
    await writeFile(mode, "done")
  }
  await waitReady()
  const query = Bun.spawn(
    [
      "python3",
      "-c",
      "import sqlite3,sys; db=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); print(db.execute(\"SELECT body FROM documents WHERE kind='review_preparation'\").fetchone()[0]); db.close()",
      join(f.root, "appdata", "reviewbox.sqlite3"),
    ],
    { stdout: "pipe", stderr: "pipe" }
  )
  const checkpoint = JSON.parse(await new Response(query.stdout).text())
  assert.equal(await query.exited, 0, await new Response(query.stderr).text())
  const runState = checkpoint.state
  const usage = new Map<string, unknown>()
  const helpers = new Map<string, unknown>()
  for (const event of runState.events) {
    if (event.progress?.type === "usage")
      usage.set(event.progress.id, event.progress)
    if (event.progress?.type === "delegation")
      helpers.set(event.progress.id, event.progress)
  }
  await writeFile(
    join(ui.artifacts, `preparation-${live ? "live" : "fixture"}-metrics.json`),
    JSON.stringify(
      {
        elapsedMs: Number(runState.updatedAt) - Number(runState.startedAt),
        steps: runState.steps.length,
        completedResults: runState.completedBatches,
        providerCalls: checkpoint.measurements?.length ?? null,
        measurements: checkpoint.measurements ?? [],
        reportedUsageInRetainedHistory: [...usage.values()],
        observedHelpersInRetainedHistory: [...helpers.values()],
        note: "Provider-reported usage in retained events only; no monetary estimate or inferred child usage.",
      },
      null,
      2
    )
  )
  assert.equal(
    await ui.execute(`return !!document.querySelector('${history}')`),
    false,
    "ready details are folded"
  )
  await ui.named("Details", "button", false)
  await ui.named("Show activity")
  assert(await ui.execute(`return !!document.querySelector('${history}')`))
  assert(
    !(await ui.text()).includes("topics drafted"),
    "grouped Codex results do not display the obsolete topic-draft counter"
  )
  for (const [width, height] of [
    [1440, 900],
    [800, 600],
  ]) {
    await ui.resize(width, height)
    assert.deepEqual((await ui.layout()).overflow, [])
    await ui.screenshot(`progress-${live ? "live" : "fixture"}-${width}`)
  }
  await ui.resize(1440, 900)
  await ui.named("Start review")
  await ui.until('!document.querySelector("[data-testid=preparing-review]")')
  await ui.element('[aria-label="Review steps"]')
  if (!live) {
    assert.equal(
      await ui.execute(
        `return document.querySelectorAll('[aria-label="Review steps"] > li').length`
      ),
      2,
      "file explanations are not additional guided steps"
    )
    const runCalls = (await readFile(calls, "utf8")).trim().split("\n")
    assert.equal(
      runCalls.filter((kind) => kind === "outline").length,
      1,
      "resume preserves the outline checkpoint"
    )
    assert.equal(
      runCalls.filter((kind) => kind === "fileExplanation").length,
      0,
      "documents are only generated for contextual reading steps"
    )
    assert.equal(
      runCalls.filter((kind) => kind === "pseudo").length,
      0,
      "no translation calls are scheduled"
    )
  }
  await ui.keys("\uE00C")
  if (selection) {
    await ui.named("Code", '[role="tab"]')
    await ui.named("Files")
    await ui.until(
      '!!document.querySelector("[aria-label=\\"Review files\\"]")'
    )
    for (const path of [
      "skip-notes.md",
      "skip-settings.json",
      "skip-types.ts",
    ]) {
      await ui.named(path, '[aria-label="Review files"] button', false)
      await ui.has("Read-only")
      await ui.until(
        '[...document.querySelectorAll("button")].some(button => button.textContent.trim() === "Validate file and continue" && !button.disabled)'
      )
      await ui.named("Validate file and continue")
    }
    await ui.named("skip-types.ts", '[aria-label="Review files"] button', false)
    await ui.has("Read-only")
    await ui.screenshot("selection-omitted-file")
  }
  assert.equal(f.git("write-tree"), f.index)
  assert.deepEqual(await ui.execute("return window.__uiErrors"), [])
  console.log(
    live
      ? "Native preparation (real Codex): generated and opened a review with three-level documents"
      : "Native preparation (fixture): native ownership, cancellation, checkpoint resume, bounded progress, three-level documents without translation passed"
  )
} catch (error) {
  await ui.screenshot("progress-failure").catch(() => {})
  console.error(await ui.text().catch(() => "No UI"))
  throw error
} finally {
  await ui.stop()
  await f.cleanup()
}
