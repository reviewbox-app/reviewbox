import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { NativeUI, fixture } from "../tests/native/ui-driver"
import { createPreparationHarness } from "../tests/native/preparation-fixture"

process.env.REVIEWBOX_NATIVE_PORT ??= "14473"
process.env.REVIEWBOX_NATIVE_ARTIFACTS ??=
  "artifacts/validation/step-preparation"
const ui = new NativeUI()
const f = await fixture()
const harness = await createPreparationHarness(f.root, false, 12)
await writeFile(harness.outlineMode, "wait")
const rows = '[aria-label="Prepared outline"] li'
const states = () =>
  ui.execute<string[]>(
    `return [...document.querySelectorAll('${rows}')].map(row=>row.dataset.state)`
  )
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
  await ui.setHarnessExecutable("codex", harness.executable)
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
    `document.querySelectorAll('${rows}').length===1`,
    "first complete outline step"
  )
  await ui.until(
    `!!document.querySelector('${rows}[data-state="writing"]')`,
    "writing starts while analysis is still open"
  )
  assert((await readFile(harness.calls, "utf8")).includes("readingStep"))
  assert(!(await ui.text()).includes("Private direction"))
  await ui.screenshot("outline-first-step")
  await writeFile(harness.outlineMode, "done")
  await ui.until(
    `document.querySelectorAll('${rows}[data-state="writing"]').length===8`,
    "eight writers"
  )
  assert.equal((await states()).length, 12)
  await ui.execute(
    `const row=document.querySelector('${rows}');window.__firstStep=row;let list=row.parentElement;while(list && getComputedStyle(list).overflowY!=='auto')list=list.parentElement;window.__page=list;if(list){list.scrollTop=120;window.__scrollTop=list.scrollTop;}return true`
  )
  await writeFile(harness.mode, "one")
  await ui.until(
    `document.querySelectorAll('${rows}[data-state="ready"]').length===1`,
    "one independent completed step"
  )
  assert(
    await ui.execute(
      `return window.__firstStep===document.querySelector('${rows}')`
    ),
    "Updates preserve mounted rows"
  )
  assert.equal(
    await ui.execute(
      `return Math.abs((window.__page?.scrollTop??0)-(window.__scrollTop??0))<2`
    ),
    true
  )
  assert.equal(
    await ui.execute(
      `return getComputedStyle(document.querySelector('${rows}[data-state="ready"] .opacity-100')).opacity`
    ),
    "1"
  )
  assert.equal(
    await ui.execute(
      `return getComputedStyle(document.querySelector('${rows}[data-state="writing"] .opacity-60')).opacity`
    ),
    "0.6"
  )
  const checkLayout = async () =>
    assert(
      await ui.execute(`
    const workers=document.querySelector('[aria-label="Preparation workers"]');
    const steps=document.querySelector('[aria-label="Reading path preparation"]');
    const activity=document.querySelector('[aria-label="Rev activity"]');
    return !!workers && !!steps && !!activity && !activity.contains(workers)
      && !!(workers.compareDocumentPosition(steps)&Node.DOCUMENT_POSITION_FOLLOWING)
      && !!(steps.compareDocumentPosition(activity)&Node.DOCUMENT_POSITION_FOLLOWING)
      && [workers,steps,...steps.querySelectorAll('*')].every(n=>getComputedStyle(n).maxHeight==='none' || n.tagName==='svg');
  `),
      "Workers precede unbounded steps outside the activity viewport"
    )
  await checkLayout()
  await ui.screenshot("one-step-ready")
  await ui.named("Continue browsing")
  await ui.until('!document.querySelector("[data-testid=preparing-review]")')
  await ui.click('[data-testid="rev-control"] button')
  await ui.named("In progress", '[role="menuitem"]')
  await ui.until(
    `document.querySelectorAll('[role="dialog"] ${rows}').length===12`
  )
  assert.equal((await states()).filter((s) => s === "ready").length, 1)
  await checkLayout()
  await ui.named("Cancel", '[role="dialog"] button')
  await ui.has("Preparation stopped. The review files are kept.")
  assert.equal((await states()).filter((s) => s === "ready").length, 1)
  assert(
    (await states())
      .filter((s) => s !== "ready")
      .every((s) => s === "interrupted")
  )
  await ui.screenshot("cancelled-retains-ready")
  await writeFile(harness.mode, "done")
  await ui.named("Resume preparation", '[role="dialog"] button')
  await ui.has("Your review is updated")
  const inputs = (await readFile(harness.writingInputs, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  assert.equal(
    inputs.filter((input) => input.id === "step:0:0").length,
    1,
    "Resume does not repeat saved step"
  )
  assert.equal(f.git("write-tree"), f.index)
  console.log(
    "Native step preparation passed: progressive outline, eight writers, independent ready states, opacity, stable rows, scroll, shared dialog, cancellation and resume."
  )
} catch (error) {
  await ui.screenshot("failure").catch(() => {})
  throw error
} finally {
  await ui.stop()
  await f.cleanup()
}
