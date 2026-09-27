import assert from "node:assert/strict"
import { mkdir, readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { NativeUI, fixture } from "../tests/native/ui-driver"

const f = await fixture()
const ui = new NativeUI()
// Distinct text keeps the content-addressed cache from collapsing this to one
// write. A bounded 32 MiB fixture leaves enough real copying work to cancel via UI.
const count = 256
const bytesPerFile = 128 * 1024
await mkdir(join(f.repo, "capture-fixture"))
for (let index = 0; index < count; index++) {
  const heading = `// Capture fixture ${index}\n`
  const body = "// immutable source content for native capture validation\n"
  const size = bytesPerFile - heading.length
  await f.write(
    `capture-fixture/file-${String(index).padStart(3, "0")}.ts`,
    heading + body.repeat(Math.ceil(size / body.length)).slice(0, size)
  )
}
const sourcePaths = [
  ...new Set(
    f
      .git("ls-files", "-co", "--exclude-standard", "-z")
      .split("\0")
      .filter(Boolean)
  ),
].sort()
async function sourceFingerprint() {
  const currentPaths = [
    ...new Set(
      f
        .git("ls-files", "-co", "--exclude-standard", "-z")
        .split("\0")
        .filter(
          (path) =>
            path && path !== ".reviewbox" && !path.startsWith(".reviewbox/")
        )
    ),
  ].sort()
  assert.deepEqual(
    currentPaths,
    sourcePaths,
    "the source file inventory stays unchanged"
  )
  const hash = new Bun.CryptoHasher("sha256")
  for (const path of sourcePaths) {
    hash.update(path + "\0")
    hash.update(await readFile(join(f.repo, path)))
  }
  return hash.digest("hex")
}
const beforeSources = await sourceFingerprint()
const beforeIndex = f.git("write-tree")
const documents = (kind: "reviews" | "snapshots") =>
  readdir(join(f.repo, ".reviewbox", kind)).catch(() => [] as string[])
const nextReady =
  "[...document.querySelectorAll('[role=dialog] footer button')].some(button=>button.textContent.trim()==='Next' && !button.disabled)"

async function toPreparation() {
  await ui.has("Continue without Rev")
  await ui.named("Continue without Rev")
  await ui.has("What do you want to review?")
  await ui.until(
    "document.querySelector('[role=dialog] [role=checkbox]')?.getAttribute('aria-checked') === 'false'",
    "untracked files included by default"
  )
  await ui.until(nextReady)
  await ui.named("Next")
  await ui.has("How should we prepare the reading?")
  await ui.until(
    "[...document.querySelectorAll('[aria-label=\"Review preparation\"] label')].find(label=>label.textContent.includes('Myself'))?.querySelector('[role=radio]')?.getAttribute('aria-checked')==='true'"
  )
}

try {
  await ui.start(`${f.root}/appdata`)
  await ui.named("Settings")
  await ui.wait(
    async () =>
      (await ui.request<string[]>(ui.route("/window/handles"))).includes(
        "settings"
      ),
    "settings window"
  )
  await ui.request(ui.route("/window"), { handle: "settings" })
  await ui.named("Rev", "nav button")
  await ui.setHarnessExecutable("codex", join(f.root, "missing-codex"))
  await ui.setHarnessExecutable("claude", join(f.root, "missing-claude"))
  await ui.has("Not detected")
  await ui.request(ui.route("/window"), { handle: "main" })
  await ui.named("or enter a path")
  await ui.fill('[aria-label="Repository path"]', f.repo)
  await ui.named("Open")
  await toPreparation()
  assert.deepEqual(await documents("reviews"), [])
  assert.deepEqual(await documents("snapshots"), [])
  await ui.named("Start review")
  await ui.until(
    `document.body.innerText.includes('Copying review files…') && document.body.innerText.includes('Reading working files') && Number(document.querySelector('[aria-label="Capture progress"]')?.getAttribute('aria-valuenow')) > 0 && Number(document.querySelector('[aria-label="Capture progress"]')?.getAttribute('aria-valuenow')) < 100`,
    "real worktree-copy progress before publication"
  )
  const progress = await ui.execute<{ value: string; text: string }>(
    `return {value:document.querySelector('[aria-label="Capture progress"]').getAttribute('aria-valuenow'),text:document.querySelector('[role=dialog] [aria-live=polite]').innerText}`
  )
  await ui.named("Cancel", "[role=dialog] footer button")
  await ui.until(
    '!document.querySelector("[role=dialog]")',
    "capture cancellation completed"
  )
  assert.deepEqual(
    await documents("reviews"),
    [],
    "cancellation publishes no review"
  )
  assert.deepEqual(
    await documents("snapshots"),
    [],
    "cancellation publishes no snapshot"
  )
  assert.equal(
    await sourceFingerprint(),
    beforeSources,
    "cancel leaves every source byte intact"
  )
  assert.equal(
    f.git("write-tree"),
    beforeIndex,
    "cancel leaves the Git index intact"
  )

  await ui.keys("\uE03D", "n")
  await toPreparation()
  await ui.execute(
    "document.querySelector('[role=dialog]').focus();return true"
  )
  // Both presses share one event batch, without waiting for React to render.
  // NativeUI bridges the driver's missing modifiers on special keys.
  await ui.keys("\uE03D", "\uE007", "\uE007")
  await ui.wait(
    () =>
      ui.execute(
        'return !document.querySelector("[role=dialog]") && !!document.querySelector(".monaco-editor")'
      ),
    "one completed manual review",
    60000
  )
  assert.equal(
    (await documents("reviews")).length,
    1,
    "double start creates exactly one review"
  )
  assert.equal(
    (await documents("snapshots")).length,
    1,
    "double start creates exactly one snapshot"
  )
  assert.equal(
    await sourceFingerprint(),
    beforeSources,
    "capture leaves every source byte intact"
  )
  assert.equal(
    f.git("write-tree"),
    beforeIndex,
    "capture leaves the Git index intact"
  )
  assert.deepEqual(await ui.execute("return window.__uiErrors"), [])
  await Bun.write(
    join(ui.artifacts, "capture.json"),
    JSON.stringify(
      {
        files: count,
        bytesPerFile,
        cancelledAt: progress,
        reviewCount: 1,
        snapshotCount: 1,
        sourcesUnchanged: true,
        indexUnchanged: true,
      },
      null,
      2
    )
  )
  console.log(
    "Native capture: real progress, cancellation before publication, unchanged sources/index and double keyboard start producing one manual review passed"
  )
} catch (error) {
  await ui.screenshot("capture-failure").catch(() => {})
  console.error(await ui.text().catch(() => "No UI"))
  throw error
} finally {
  await ui.stop()
  await f.cleanup()
}
