import assert from "node:assert/strict"
import { readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { NativeUI, fixture } from "../tests/native/ui-driver"
import { createPreparationHarness } from "../tests/native/preparation-fixture"

process.env.REVIEWBOX_NATIVE_PORT ??= "14478"
process.env.REVIEWBOX_NATIVE_ARTIFACTS ??= "artifacts/validation/finalization"
const f = await fixture()
const ui = new NativeUI()
const harness = await createPreparationHarness(f.root, false, 2)
await writeFile(harness.mode, "done")
const project = join(f.repo, ".reviewbox")
let unlock: (() => Promise<void>) | undefined

async function names(path: string) {
  return readdir(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []
    throw error
  })
}
async function draft(id: string) {
  return JSON.parse(
    await readFile(
      join(project, ".local/reviews", id, "reviews", id, "review.json"),
      "utf8"
    )
  )
}
async function homeMenu() {
  await ui.named("Home", '[role="tab"]')
  await ui.named("Review actions")
  await ui.until('!!document.querySelector("[role=menu]")')
}
async function holdProjectWriter() {
  const python = Bun.which("python3")
  assert(python, "python3 provides the fixture's native advisory lock")
  const holder = Bun.spawn(
    [
      python,
      "-c",
      [
        "import fcntl, sys",
        "with open(sys.argv[1], 'a+') as lock:",
        "    fcntl.flock(lock, fcntl.LOCK_EX)",
        "    print('locked', flush=True)",
        "    sys.stdin.read(1)",
      ].join("\n"),
      join(project, ".local/write.lock"),
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" }
  )
  const reader = holder.stdout.getReader()
  const first = await reader.read()
  assert(
    new TextDecoder().decode(first.value).includes("locked"),
    "fixture holds the project writer lock"
  )
  reader.releaseLock()
  return async () => {
    holder.stdin.write("x")
    holder.stdin.end()
    assert.equal(await holder.exited, 0)
  }
}

try {
  await ui.start(join(f.root, "appdata"))
  await ui.resize(1440, 900)
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
  await ui.wait(
    async () => {
      const error = await ui.execute<string>(
        'return document.querySelector("[data-testid=preparing-review] [role=alert]")?.textContent ?? ""'
      )
      assert(!error, error)
      return (await ui.text()).includes("Your review is ready")
    },
    "prepared review",
    120000
  )
  await ui.named("Start review")
  await ui.has("Step 1 of 2")
  await ui.named("Validate step and continue")
  await ui.has("Step 2 of 2")
  await ui.until(
    '[...document.querySelectorAll("button")].find(e=>e.textContent.trim()==="Validate step and continue")?.disabled === false'
  )
  const [guidedId] = await names(join(project, ".local/reviews"))
  assert(guidedId)

  // Hold the real OS writer lock, not the IPC or product state. The native job
  // will report project_busy after its bounded lock retry; the WebView stays live.
  unlock = await holdProjectWriter()
  await ui.execute(`window.__finalizationObservation={summary:false,unconfirmed:false,running:false};
    const observe=()=>{const section=document.querySelector('[aria-label="Review finalization"]');
      const text=section?.textContent??'';const all=document.body.innerText;
      if(all.includes('Finalizing review'))window.__finalizationObservation.summary=true;
      if(text.includes('Saving your final review decision')&&all.includes('1 of 2 steps validated'))window.__finalizationObservation.unconfirmed=true;
      if(text.includes('Save review completion')&&text.includes('In progress'))window.__finalizationObservation.running=true;};
    window.__finalizationObserver=new MutationObserver(observe);window.__finalizationObserver.observe(document.body,{subtree:true,childList:true,characterData:true});return true;`)
  await ui.named("Validate step and continue")
  await ui.has("Review needs attention")
  assert.deepEqual(
    await ui.execute("return window.__finalizationObservation"),
    { summary: true, unconfirmed: true, running: true }
  )
  assert.equal(
    (await draft(guidedId)).data.publication.completion,
    null,
    "failed save must not persist a completion"
  )
  await ui.has("Your final decision has not been confirmed as saved.")
  await ui.has("Copy error details")
  await ui.screenshot("finalization-save-failed")
  await unlock()
  unlock = undefined
  await ui.execute("window.__finalizationObserver.disconnect();return true")

  await ui.named("Retry finalization")
  await ui.named("Back home", "main[aria-label=Review] button")
  await ui.named("Review", '[role="tab"]')
  await ui.has("Review complete")
  await ui.has("2 of 2 steps validated")
  await ui.has("Finalization finished")
  await ui.has("Stage & commit with Rev")
  const published = await names(join(project, "published"))
  assert.deepEqual(published, [guidedId], "retry publishes this review once")
  const completed = JSON.parse(
    await readFile(
      join(project, "published", guidedId, "reviews", guidedId, "review.json"),
      "utf8"
    )
  )
  assert.equal(completed.data.publication.status, "published")
  assert.equal(
    (
      await names(
        join(project, "published", guidedId, "reviews", guidedId, "decisions")
      )
    ).length,
    2,
    "retry creates no duplicate validation"
  )
  assert.equal(f.git("write-tree"), f.index, "finalization does not stage")
  await ui.screenshot("finalization-published-resumed")

  await ui.keys("\uE03D", "n")
  await ui.startManualReview()
  const [manualId] = (await names(join(project, ".local/reviews"))).filter(
    (id) => id !== guidedId
  )
  assert(manualId)
  await ui.named("End review")
  await ui.has("Review summary")
  assert.equal((await draft(manualId)).data.publication.status, "draft")
  assert.equal(
    await ui.execute(
      'return !!document.querySelector("[aria-label=\\"Review finalization\\"]")'
    ),
    false,
    "manual End review is only a summary"
  )
  await ui.named("Back to review")
  await ui.has("End review")

  // Exercise Home's explicit completion entry point as well as the reader.
  await homeMenu()
  await ui.named("Keep this review local", '[role="menuitemcheckbox"]')
  await ui.keys("\uE00C")
  await ui.until('!document.querySelector("[role=menu]")')
  await ui.wait(
    async () => (await draft(manualId)).data.publication.keepLocal === true,
    "local setting saved"
  )
  await ui.named("Review actions")
  await ui.named("Complete review", '[role="menuitem"]', false)
  await ui.has("Review complete")
  await ui.has("Completed and kept local.")
  await ui.until(
    'document.querySelectorAll("[aria-label=\\"Finalization steps\\"] li").length >= 7'
  )
  assert.equal(
    await ui.execute(
      'return [...document.querySelectorAll("[aria-label=\\"Finalization steps\\"] li")].filter(e=>e.textContent.includes("Not needed")).length'
    ),
    5,
    "local completion skips the five publication steps"
  )
  assert.equal(
    (await draft(manualId)).data.publication.status,
    "completedLocal"
  )
  assert.deepEqual(await names(join(project, "published")), [guidedId])
  assert.equal(f.git("write-tree"), f.index)
  const errors = await ui.execute<string[]>("return window.__uiErrors")
  // WebKit/Monaco can defer a resize notification after window resizing. Keep
  // that warning in screenshot artifacts, but fail on all application errors.
  assert.deepEqual(
    errors.filter(
      (error) =>
        error !==
        "ResizeObserver loop completed with undelivered notifications."
    ),
    []
  )
  assert.deepEqual((await ui.layout()).overflow, [])
  await ui.screenshot("finalization-manual-local")
  console.log(
    "Native finalization: immediate summary, durable save failure, retry without duplicate decisions, navigation resume, explicit Home completion, local skips and unchanged manual End review passed"
  )
} catch (error) {
  await ui.screenshot("finalization-failure").catch(() => {})
  console.error(await ui.text().catch(() => "No UI"))
  throw error
} finally {
  await unlock?.().catch(() => {})
  await ui.stop()
  await f.cleanup()
}
