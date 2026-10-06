import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { NativeUI, fixture } from "../tests/native/ui-driver"
import { createPreparationHarness } from "../tests/native/preparation-fixture"

process.env.REVIEWBOX_NATIVE_PORT ??= "14487"
process.env.REVIEWBOX_NATIVE_ARTIFACTS ??= "artifacts/validation/local-comments"
const f = await fixture()
const ui = new NativeUI()
const notes = join(f.repo, ".reviewbox/.local/REVIEW_COMMENTS.md")
const harness = await createPreparationHarness(f.root, false, 1)
await writeFile(harness.mode, "done")
f.git("add", ".")
f.git("commit", "-qm", "Clean local code fixture")
const index = f.git("write-tree")
await f.write(
  ".git/info/exclude",
  ".reviewbox/\n.agents/\nAGENTS.md\n.gitignore\n.tmp*\n"
)
let phase = "clean checkout"
async function selectSource(selector: string) {
  await ui.click(selector)
  // The macOS WebDriver click omits Monaco's pointer-down focus transfer.
  await ui.execute(
    `document.querySelector(arguments[0]).closest('.monaco-editor').querySelector('textarea').focus();return true`,
    [selector]
  )
  await ui.shortcut("a")
  await ui.has("Add comment")
  await ui.named("Add comment")
}
try {
  await ui.start(join(f.root, "appdata"))
  await ui.resize(1440, 900)
  console.log("Native local comments: clean checkout")
  await ui.named("or enter a path")
  await ui.fill('[aria-label="Repository path"]', f.repo)
  await ui.named("Open")
  await writeFile(
    join(ui.artifacts, "startup-errors.json"),
    JSON.stringify(await ui.execute("return window.__uiErrors ?? []"), null, 2)
  )
  await ui.execute("window.__uiErrors=[];return true")
  await ui.named("View local code")
  await ui.until(
    `document.querySelector('[aria-label="Review file mode"]')?.disabled === true`
  )
  assert(
    (
      await ui.execute<string>(
        `return document.querySelector('[aria-label="Review file mode"]').textContent`
      )
    ).includes("All files")
  )
  await ui.click('nav[aria-label="Changed files"] [data-folder="src"]')
  await ui.click('nav[aria-label="Changed files"] [title="src/answer.ts"]')
  await ui.wait(
    () =>
      ui.execute<boolean>(
        `return document.querySelector('section[aria-label="Unchanged source"] .view-lines')?.textContent.includes('answer') === true`
      ),
    "visible unchanged source",
    10000
  )
  await selectSource('section[aria-label="Unchanged source"] .view-line span')
  await ui.fill('[aria-label="Review comment"]', "Local unchanged source note")
  await ui.named("Save comment")
  await ui.wait(
    async () =>
      (await readFile(notes, "utf8").catch(() => "")).includes(
        "Local unchanged source note"
      ),
    "unchanged source note"
  )
  phase = "version conflict"
  console.log("Native local comments: version conflict")
  await selectSource('section[aria-label="Unchanged source"] .view-line span')
  await ui.fill(
    '[aria-label="Review comment"]',
    "Keep this draft when the file changes"
  )
  await f.write("src/answer.ts", "export const answer = 44;\n")
  await ui.named("Save comment")
  await ui.has("Select the source again")
  assert.equal(
    await ui.execute(
      `return document.querySelector('[aria-label="Review comment"]').value`
    ),
    "Keep this draft when the file changes"
  )
  await ui.named("Select source again")
  await ui.until(
    `document.querySelector('[aria-label="Review file mode"]')?.disabled === false`
  )
  await ui.until(
    `document.querySelector('.block-after .view-lines')?.textContent.includes('44')`
  )
  await selectSource(".block-after .view-line span")
  assert.equal(
    await ui.execute(
      `return document.querySelector('[aria-label="Review comment"]').value`
    ),
    "Keep this draft when the file changes"
  )
  await ui.named("Save comment")
  await ui.wait(
    async () => (await readFile(notes, "utf8")).includes("Keep this draft"),
    "new version note"
  )
  await ui.named("Comments")
  await ui.has("2 open")
  await ui.has("earlier or unavailable source version")
  await ui.screenshot("local-comments")
  await ui.keys("\uE00C")
  await ui.named("Back to review overview")
  await ui.has("View local changes")
  phase = "Rev review"
  console.log("Native local comments: Rev review")
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
  await ui.activateWindow()
  await ui.reviewScope()
  await ui.nextReviewStep()
  await ui.named("With Rev", "label", false)
  await ui.named("Start review", "[role=dialog] footer button")
  await ui.wait(
    async () =>
      (await ui.text()).includes("Start review") &&
      (await ui.text()).includes("Your review is ready"),
    "prepared Rev review",
    90000
  )
  await ui.named("Start review")
  await ui.named("Code", '[role="tab"]')
  await ui.until(
    `document.querySelector('nav[aria-label="Review files"] [data-folder="src"]')?.getAttribute('aria-expanded') === 'true'`
  )
  await ui.click('nav[aria-label="Review files"] [title="src/answer.ts"]')
  await ui.until(
    `document.querySelector('.block-after .view-lines')?.textContent.includes('44')`
  )
  await selectSource(".block-after .view-line span")
  await ui.fill('[aria-label="Review comment"]', "Rev review source note")
  await ui.named("Save comment")
  await ui.wait(
    async () =>
      (await readFile(notes, "utf8")).includes("Rev review source note"),
    "Rev comment"
  )
  await ui.named("Comments")
  await ui.has("1 open")
  assert(!(await ui.text()).includes("Local unchanged source note"))
  await ui.keys("\uE00C")
  await ui.click('nav[aria-label="Review files"] [data-folder="src"]')
  await ui.named("Document", '[role="tab"]')
  await ui.named("Code", '[role="tab"]')
  assert.equal(
    await ui.execute(
      `return document.querySelector('nav[aria-label="Review files"] [data-folder="src"]').getAttribute('aria-expanded')`
    ),
    "false"
  )
  await ui.named("Files", "button")
  await ui.named("Document", '[role="tab"]')
  await ui.named("Code", '[role="tab"]')
  assert.equal(
    await ui.execute(
      `return document.querySelector('button[aria-label="Files"]').getAttribute('aria-pressed')`
    ),
    "false"
  )
  assert.equal(f.git("write-tree"), index)
  assert.deepEqual(
    await ui.execute(
      "return (window.__uiErrors ?? []).filter(e=>!e.includes('ResizeObserver loop'))"
    ),
    []
  )
  await ui.screenshot("rev-comments-layout")
  console.log(
    "Native local/Rev comments: clean checkout, forced all-files, source conflict/draft reselection, context isolation and tree restore passed."
  )
} catch (error) {
  await ui
    .execute(
      "window.__commentFrame=false;requestAnimationFrame(()=>window.__commentFrame=true);return true"
    )
    .catch(() => {})
  await Bun.sleep(300)
  console.log(
    "Native render diagnostics",
    await ui
      .execute(
        `return { visibility: document.visibilityState, focus: document.hasFocus(), frame: window.__commentFrame, editors: [...document.querySelectorAll('.monaco-editor')].map(e=>({width:e.clientWidth,height:e.clientHeight,text:e.textContent?.slice(0,200)})), errors: window.__uiErrors }`
      )
      .catch(String)
  )
  await ui.screenshot(`failed-${phase.replaceAll(" ", "-")}`).catch(() => {})
  throw error
} finally {
  await ui.stop()
  await f.cleanup()
}
