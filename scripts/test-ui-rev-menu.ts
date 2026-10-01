import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { NativeUI, fixture } from "../tests/native/ui-driver"
import { createPreparationHarness } from "../tests/native/preparation-fixture"

process.env.REVIEWBOX_NATIVE_PORT ??= "14467"
process.env.REVIEWBOX_NATIVE_ARTIFACTS ??= "artifacts/validation/rev-menu"
const ui = new NativeUI()
let expectedIndex: string
const f = await fixture()
expectedIndex = f.index
const harness = await createPreparationHarness(f.root, false, 3)
// Keep the adaptation call alive so the real native cancellation is exercised.
await writeFile(
  harness.executable,
  (await readFile(harness.executable, "utf8")).replace(
    "const prompt=m.params.input[0].text;",
    `while(readFileSync(${JSON.stringify(harness.mode)},'utf8')==='update-wait')await Bun.sleep(100);\nconst prompt=m.params.input[0].text;`
  )
)
const control = '[data-testid="rev-control"] button'
const center = () =>
  ui.execute<number>(
    `const r=document.querySelector('[data-testid="workspace-navigation"]').getBoundingClientRect();return r.x+r.width/2`
  )
async function menu(label: string) {
  await ui.click(control)
  await ui.named(label, '[role="menuitem"]')
}
try {
  await ui.start(join(f.root, "appdata"))
  await ui.execute(`window.BASE_UI_ANIMATIONS_DISABLED=true;
    const frame=window.requestAnimationFrame.bind(window),cancel=window.cancelAnimationFrame.bind(window);
    window.requestAnimationFrame=callback=>document.hidden?-setTimeout(()=>callback(performance.now()),16):frame(callback);
    window.cancelAnimationFrame=id=>id<0?clearTimeout(-id):cancel(id);return true;`)
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
  await ui.setHarnessExecutable("codex", harness.executable)
  await ui.setDefaultHarness("codex")
  await ui.request(ui.route("/window"), { handle: "main" })
  await ui.named("or enter a path")
  await ui.fill('[aria-label="Repository path"]', f.repo)
  await ui.named("Open")
  await ui.element('[data-testid="workspace-navigation"]')
  const originalCenter = await center()
  await ui.reviewScope()
  await ui.nextReviewStep()
  await ui.named("With Rev", "label", false)
  await ui.named("Start review", "[role=dialog] footer button")
  await ui.has("Progress note 11")
  const phases = await ui.execute<string>(
    `return document.querySelector('[aria-label="Rev’s work"]').textContent`
  )
  await ui.named("Continue browsing")
  await ui.until('!document.querySelector("[data-testid=preparing-review]")')
  assert(
    Math.abs((await center()) - originalCenter) < 1,
    "Rev control preserves the navigation center"
  )
  assert.equal(
    await ui.execute(
      `return getComputedStyle(document.querySelector('[data-testid="rev-control"]')).position`
    ),
    "absolute"
  )
  assert.equal(
    await ui.execute(
      'return !!document.querySelector("[data-testid=review-update-status]")'
    ),
    false
  )
  await menu("In progress")
  assert.equal(
    await ui.execute(
      `return document.querySelector('[role="dialog"] [aria-label="Rev’s work"]').textContent`
    ),
    phases
  )
  assert.equal(
    await ui.execute(
      `return document.querySelector('[aria-label="Rev preparation details"]').scrollTop`
    ),
    0,
    "dialog opens at its title"
  )
  await ui.screenshot("progress-dialog")
  await ui.named("Close", '[role="dialog"] button')
  await ui.until('!document.querySelector("[role=dialog]")')
  await writeFile(harness.mode, "done")
  await ui.until(
    `document.querySelector('${control}')?.getAttribute('aria-label') === 'Rev: Review done'`
  )
  await ui.until(
    `document.querySelector('${control}')?.dataset.revStatus === 'done'`
  )
  await ui.click(control)
  assert.equal(
    await ui.execute(
      `return document.querySelector('${control}').dataset.revStatus`
    ),
    "done",
    "opening the dropdown alone does not acknowledge completion"
  )
  await ui.named("Review done", '[role="menuitem"]')
  await ui.has("Your review is updated")
  await ui.until(
    `document.querySelector('${control}')?.dataset.revStatus === 'seen'`
  )
  const writingInputs = (await readFile(harness.writingInputs, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  assert.equal(new Set(writingInputs.map((input) => input.id)).size, 3)
  for (const input of writingInputs) {
    const index = Number(input.id.split(":").at(-1))
    assert.equal(
      input.step.writingBrief,
      `Private direction ${index + 1}: explain the value before and after the change and its effect on associated files.`
    )
    assert(input.step.contextSourceIds.length > 0)
    for (const id of input.step.contextSourceIds) {
      assert(
        input.sources.some(
          (source: { sourceId: string }) => source.sourceId === id
        )
      )
      assert(
        input.capturedSources.some(
          (source: { sourceId: string }) => source.sourceId === id
        )
      )
    }
  }
  assert(!(await ui.text()).includes("Private direction"))
  const buttons = '[aria-label="Review update actions"] button'
  assert.deepEqual(
    await ui.execute(
      `return [...document.querySelectorAll('${buttons}')].map(b=>b.textContent)`
    ),
    ["Update with Rev", "Back to review"]
  )
  assert(
    await ui.execute(
      `return document.querySelectorAll('${buttons}')[1].classList.contains('bg-primary')`
    )
  )
  assert.equal(
    await ui.execute(
      `return getComputedStyle(document.querySelector('[aria-label="Review update actions"]')).justifyContent`
    ),
    "flex-end"
  )
  assert.equal(
    await ui.execute(
      `return getComputedStyle(document.querySelector('[aria-label="Rev preparation details"] > div')).paddingTop`
    ),
    "24px"
  )
  await ui.named("Back to review", '[role="dialog"] button')
  await ui.until('!document.querySelector("[role=dialog]")')
  assert.equal(
    await ui.execute(
      `return document.querySelector('${control}').dataset.revStatus`
    ),
    "seen",
    "closing the completed pass keeps its notification acknowledged"
  )
  await ui.element('[aria-label="Review steps"]')
  await ui.named("Behavior 3", '[aria-label="Review steps"] button', false)
  await ui.named("Validate step and continue")
  await ui.has("Review summary")
  await ui.has("1 of 3 steps validated")
  await ui.has("Understand the changed behavior.")
  assert(!(await ui.text()).includes("End of the tour"))
  await ui.screenshot("partial-summary")
  await ui.named("Back to review")
  await f.write("src/answer.ts", "export const answer = 99;\n")
  f.git("add", "src/answer.ts")
  expectedIndex = f.git("write-tree")
  await ui.execute('window.dispatchEvent(new Event("focus"));return true')
  await ui.wait(
    () =>
      ui.execute(
        'return !!document.querySelector("button[aria-label=\\"Dismiss repository changes\\"]")'
      ),
    "repository change alert",
    45000
  )
  await ui.named("Dismiss repository changes")
  await ui.execute('window.dispatchEvent(new Event("focus"));return true')
  await Bun.sleep(1000)
  assert.equal(
    await ui.execute(
      'return !!document.querySelector("button[aria-label=\\"Dismiss repository changes\\"]")'
    ),
    false
  )
  await writeFile(harness.mode, "update-wait")
  await ui.until(
    `document.querySelector('${control}')?.dataset.revStatus === 'stale'`
  )
  await menu("Update with Rev")
  await ui.has("Your review needs an update")
  assert(
    !(
      await ui.execute<string>(
        `return document.querySelector('[role="dialog"]').textContent`
      )
    ).includes("Preparation finished")
  )
  assert.deepEqual(
    await ui.execute(
      `return [...document.querySelectorAll('[aria-label="Review update actions"] button')].map(b=>b.textContent)`
    ),
    ["Back to review", "Update with Rev"]
  )
  assert.equal(
    await ui.execute(
      `return document.querySelectorAll('[aria-label="Steps of the review"] .line-through').length`
    ),
    2
  )
  assert(
    await ui.execute(
      `return document.querySelector('[aria-label="Review update actions"] button').classList.contains('bg-accent')`
    )
  )
  await ui.screenshot("update-needed")
  await ui.named("Update with Rev", '[role="dialog"] button')
  await ui.has("Rev is updating your review")
  await ui.named("Close", '[role="dialog"] [data-slot="dialog-close"]')
  await ui.until('!document.querySelector("[role=dialog]")')
  await menu("In progress")
  await ui.has("Rev is updating your review")
  await ui.named("Cancel", '[role="dialog"] button')
  await ui.has("Preparation stopped. The review files are kept.")
  await ui.named("Discard update", '[role="dialog"] button')
  await ui.has("Update discarded. Your review is unchanged.")
  await ui.named("Close", '[role="dialog"] [data-slot="dialog-close"]')
  await menu("Delete current review")
  await ui.named("Cancel", '[role="alertdialog"] button')
  await ui.until('!document.querySelector("[role=alertdialog]")')
  await menu("Delete current review")
  await ui.named("Delete review", '[role="alertdialog"] button')
  await ui.until('!document.querySelector("[data-testid=rev-control]")')
  assert.equal(
    f.git("write-tree"),
    expectedIndex,
    "review actions never stage files"
  )
  assert.deepEqual(await ui.execute("return window.__uiErrors"), [])
  console.log(
    "Native Rev menu: shared preparation, background completion, centered control, partial summary, dismissed changes and confirmed deletion passed."
  )
} catch (error) {
  console.error(
    await ui
      .execute(
        `return document.querySelector('[data-testid="rev-control"]')?.outerHTML`
      )
      .catch(() => "No Rev control")
  )
  await ui.screenshot("failure").catch(() => {})
  throw error
} finally {
  await ui.stop()
  await f.cleanup()
}
