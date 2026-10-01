import assert from "node:assert/strict"
import { join } from "node:path"
import { NativeUI, fixture } from "../tests/native/ui-driver"

const f = await fixture()
const ui = new NativeUI()
let phase = "empty project settings"
// Covered WKWebViews pause animation frames, including popup exit/focus work.
const enableFrames = () =>
  ui.execute(`window.BASE_UI_ANIMATIONS_DISABLED=true;
    const frame=window.requestAnimationFrame.bind(window),cancel=window.cancelAnimationFrame.bind(window);
    window.requestAnimationFrame=callback=>document.hidden?-setTimeout(()=>callback(performance.now()),16):frame(callback);
    window.cancelAnimationFrame=id=>id<0?clearTimeout(-id):cancel(id);return true`)
const openSettings = async () => {
  await ui.named("Settings")
  await ui.wait(
    async () =>
      (await ui.request<string[]>(ui.route("/window/handles"))).includes(
        "settings"
      ),
    "settings window"
  )
  await ui.request(ui.route("/window"), { handle: "settings" })
  await ui.has("Code colors")
  await enableFrames()
}
const closeSettings = async () => {
  await ui.request(ui.route("/window"), undefined, "DELETE")
  await ui.request(ui.route("/window"), { handle: "main" })
}
try {
  await ui.start(join(f.root, "appdata"))
  await enableFrames()
  await openSettings()
  await ui.named("Project", "nav button")
  await ui.has("Open a repository first")
  await ui.select("#settings-project", "Open a repository first")
  await ui.named("Languages", "nav button")
  await ui.has("No open project")
  await ui.select("#languages-project", "No open project")
  await closeSettings()

  phase = "captured project and language selector"
  await ui.named("or enter a path")
  await ui.fill('[aria-label="Repository path"]', f.repo)
  await ui.named("Open")
  await ui.startManualReview()
  await openSettings()
  await ui.named("Languages", "nav button")
  await ui.element("#languages-project")
  const projectLabel = await ui.execute<string>(
    "return document.querySelector('#languages-project').textContent.trim()"
  )
  assert(projectLabel && projectLabel !== "No open project")
  await ui.select("#languages-project", projectLabel)
  await closeSettings()

  phase = "Rev action and harness selectors"
  await ui.named("Code Explain", '[role="tab"]')
  await ui.fill('[aria-label="Filter files"]', "answer.ts")
  await ui.click('[aria-label="Snapshot files"] button[aria-expanded="false"]')
  await ui.named("answer.ts", '[aria-label="Snapshot files"] button', false)
  await ui.named("Explain with Rev")
  await ui.select(
    'button[aria-label="What Rev should do"]',
    "Suggest project definitions"
  )
  await ui.select('button[aria-label="Rev\'s harness"]', "Claude Code")
  await ui.select('button[aria-label="Rev\'s harness"]', "Codex")
  await ui.click('button[aria-label="What Rev should do"]')
  await ui.keys("\uE00C")
  await ui.until(
    "document.querySelector('button[aria-label=\"What Rev should do\"]')?.getAttribute('aria-expanded') === 'false' && document.querySelector('button[aria-label=\"What Rev should do\"]').textContent.includes('Suggest project definitions')",
    "Escape closes the popup without changing its selection"
  )
  await ui.screenshot("rev-selects")
  await ui.keys("\uE00C")

  phase = "meaning selector inside its dialog"
  await ui.named("Glossary", '[role="tab"]')
  await ui.fill("#term-name", "answer")
  await ui.fill('[aria-label="Definition"]', "The exported response value")
  await ui.named("Save meaning")
  await ui.has("The exported response value")
  await ui.named("Files", '[role="tab"]')
  await ui.named("Add a section")
  await ui.fill('[aria-label="Section title"]', "Exported answer")
  await ui.fill(
    '[aria-label="Explanation"]',
    "The answer is a constant response."
  )
  await ui.named("Save section")
  await ui.named("Explain a word")
  await ui.fill("#occurrence-word", "constant")
  await ui.has("No linked meaning")
  await ui.select("#occurrence-sense", "answer — The exported response value")
  await ui.until(
    "[...document.querySelectorAll('button')].find(el => el.textContent === 'Save for this occurrence')?.disabled === false"
  )
  await ui.select("#occurrence-sense", "No linked meaning")
  await ui.until(
    "[...document.querySelectorAll('button')].find(el => el.textContent === 'Save for this occurrence')?.disabled === true"
  )
  await ui.select("#occurrence-sense", "answer — The exported response value")
  await ui.named("Save for this occurrence")
  await ui.until("!document.querySelector('#occurrence-sense')")
  await ui.screenshot("meaning-selected")
  assert.deepEqual(await ui.execute("return window.__uiErrors"), [])
  console.log(
    "Native Selects: empty states, project labels, Rev action/harness changes, nested dialog selection/reset and save passed"
  )
} catch (error) {
  console.error("Select test phase:", phase)
  await ui.screenshot("selects-failure").catch(() => {})
  console.error(await ui.text().catch(() => "No UI"))
  throw error
} finally {
  await ui.stop()
  await f.cleanup()
}
