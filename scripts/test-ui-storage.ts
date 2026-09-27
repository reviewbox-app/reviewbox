import assert from "node:assert/strict"
import { readFile, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { NativeUI, fixture } from "../tests/native/ui-driver"

const f = await fixture()
let ui = new NativeUI()
const data = join(f.root, "appdata")
try {
  await ui.start(data)
  await ui.named("or enter a path")
  await ui.fill('[aria-label="Repository path"]', f.repo)
  await ui.named("Open")
  await ui.startManualReview()
  await ui.until("!!document.querySelector('.monaco-editor .view-line')")
  await ui.has("src/answer.ts")
  const snapshots = await readdir(join(f.repo, ".reviewbox/snapshots"))
  assert.equal(snapshots.length, 1)
  const snapshot = JSON.parse(
    await readFile(join(f.repo, ".reviewbox/snapshots", snapshots[0]), "utf8")
  )
  assert.equal(snapshot.version, 2)
  assert(Object.keys(snapshot.data.sourceIndex).length > 0)
  const packs = await readdir(join(f.repo, ".reviewbox/content", snapshot.id))
  assert.deepEqual(packs, ["0001.json"])
  await ui.stop()
  // Force reconstruction from portable Git references and packs on reopening.
  await rm(join(data, "blobs"), { recursive: true })
  await f.write("src/answer.ts", "export const answer = 999;\n")
  ui = new NativeUI()
  await ui.start(data)
  await ui.named(
    "sample-project",
    '[aria-label="Recent repositories"] button',
    false
  )
  await ui.until("!!document.querySelector('.monaco-editor .view-line')")
  await ui.has("src/answer.ts")
  const code = await ui.execute<string>(
    `return [...document.querySelectorAll('.monaco-editor .view-line')].map(line=>line.textContent).join(' ')`
  )
  assert.match(code, /41/)
  assert.match(code, /42/)
  assert(
    !code.includes("999"),
    "reopening shows captured source, not today's working tree"
  )
  await ui.named("Validate passage")
  await ui.has("Validated by Reviewer")
  assert.deepEqual(await ui.execute("return window.__uiErrors"), [])
  await ui.screenshot("storage-v2-reopened")
  console.log(
    "Native storage v2: capture, one pack, restart without source cache, exact frozen code and saved human decision passed"
  )
} catch (error) {
  await ui.screenshot("storage-v2-failure").catch(() => {})
  console.error(await ui.text().catch(() => "No UI"))
  throw error
} finally {
  await ui.stop()
  await f.cleanup()
}
