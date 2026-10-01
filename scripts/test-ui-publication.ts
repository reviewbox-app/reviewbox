import assert from "node:assert/strict"
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { NativeUI, fixture } from "../tests/native/ui-driver"

process.env.REVIEWBOX_NATIVE_PORT ??= "14463"
process.env.REVIEWBOX_NATIVE_ARTIFACTS ??= "artifacts/validation/publication"
const f = await fixture()
const ui = new NativeUI()
const project = join(f.repo, ".reviewbox")

async function names(path: string) {
  return readdir(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []
    throw error
  })
}
async function menu() {
  // Home retains actions for its selected review; the reader uses the OS menu.
  if (
    !(await ui.execute(
      'return !!document.querySelector("button[aria-label=\\"Review actions\\"]")'
    ))
  )
    await ui.named("Home", '[role="tab"]')
  await ui.named("Review actions")
  await ui.until('!!document.querySelector("[role=menu]")')
}
async function closeMenu() {
  await ui.keys("\uE00C")
  await ui.until('!document.querySelector("[role=menu]")')
}
async function publicationIds() {
  return names(join(project, "published"))
}
async function expectNoDocumentControls() {
  assert.equal(
    await ui.execute(
      `return !!document.querySelector('[aria-label="Reading mode"], [aria-label="Explanation"], [aria-label="Review steps"]') || [...document.querySelectorAll('button')].some(e=>/Validate (step|file)/.test(e.textContent))`
    ),
    false,
    "manual review retains no document controls or validation footer"
  )
}

try {
  await ui.start(join(f.root, "appdata"))
  await ui.execute(`window.BASE_UI_ANIMATIONS_DISABLED=true;
    const frame=window.requestAnimationFrame.bind(window),cancel=window.cancelAnimationFrame.bind(window);
    window.requestAnimationFrame=callback=>document.hidden?-setTimeout(()=>callback(performance.now()),16):frame(callback);
    window.cancelAnimationFrame=id=>id<0?clearTimeout(-id):cancel(id);return true;`)
  await ui.resize(1440, 900)
  await ui.named("or enter a path")
  await ui.fill('[aria-label="Repository path"]', f.repo)
  await ui.named("Open")
  await ui.startManualReview()
  await ui.until("!!document.querySelector('.monaco-editor .view-line')")
  await expectNoDocumentControls()
  assert.equal(
    JSON.parse(await readFile(join(project, "project.json"), "utf8")).version,
    4
  )
  assert.deepEqual(await publicationIds(), [])
  assert.equal(f.git("write-tree"), f.index, "draft creation preserves index")

  await menu()
  await ui.named("Keep this review local", '[role="menuitemcheckbox"]')
  await closeMenu()
  await menu()
  await ui.named("Complete review", '[role="menuitem"]', false)
  await ui.has("Completed · local")
  assert.deepEqual(await publicationIds(), [])
  await expectNoDocumentControls()
  await ui.named("Home", '[role="tab"]')
  await ui.has(
    "Manual review: the captured scope was confirmed by the reviewer."
  )
  await ui.has("Completed and kept local.")
  await ui.screenshot("manual-completed-local")

  await menu()
  await ui.named("Keep this review local", '[role="menuitemcheckbox"]')
  await closeMenu()
  await ui.wait(
    async () => (await publicationIds()).length === 1,
    "publication after opting back in"
  )
  await ui.has("Published")
  const [first] = await publicationIds()
  assert.equal(f.git("write-tree"), f.index, "publication never stages")
  f.git("add", ".")
  f.git("commit", "-qm", "Publish first reviewed change")
  const carrier = f.git("rev-parse", "HEAD").trim()
  await f.write("src/answer.ts", "export const answer = 44;\n")
  const indexAfterCommit = f.git("write-tree")

  await ui.named("Read review")
  await ui.execute('window.dispatchEvent(new Event("focus"));return true')
  await ui.has("Refresh snapshot")
  await ui.named("Refresh snapshot")
  await ui.until("!document.body.innerText.includes('Refresh snapshot')")
  await ui.until(
    "[...document.querySelectorAll('.monaco-editor .view-line')].some(e=>e.textContent.includes('44'))"
  )
  await ui.until("!!document.querySelector('.monaco-editor .view-line')")
  await menu()
  await ui.has("Local draft")
  await ui.named("Complete review", '[role="menuitem"]', false)
  await ui.has("Published")
  await ui.wait(async () => {
    const ids = await publicationIds()
    return ids.length === 1 && ids[0] !== first
  }, "old bundle archived when successor is published")
  const [second] = await publicationIds()
  const reference = JSON.parse(
    await readFile(join(project, "references", `${first}.json`), "utf8")
  )
  assert(
    JSON.stringify(reference).includes(carrier),
    "archive names first carrier commit"
  )
  assert.equal(
    f.git("write-tree"),
    indexAfterCommit,
    "refresh/publication preserves index"
  )
  assert.equal(
    await readFile(join(f.repo, "src/answer.ts"), "utf8"),
    "export const answer = 44;\n"
  )

  await ui.named("Home", '[role="tab"]')
  await ui.has("Archived")
  await ui.execute(
    `const section=[...document.querySelectorAll('aside nav section')].find(e=>e.querySelector('h2')?.textContent==='Archived');section.querySelector('button').setAttribute('data-archive-target','true');return true;`
  )
  await ui.click('[data-archive-target="true"]')
  await ui.has(carrier.slice(0, 10))
  await ui.named("Read review")
  await expectNoDocumentControls()
  await ui.until("!!document.querySelector('.monaco-editor .view-line')")
  const captured = await ui.execute<string>(
    "return [...document.querySelectorAll('.monaco-editor .view-line')].map(e=>e.textContent).join(' ')"
  )
  assert(
    !captured.includes("44"),
    "archived review never substitutes current source"
  )
  await menu()
  await ui.has("Archived in Git")
  assert.equal(
    await ui.execute(
      'return [...document.querySelectorAll("[role=menuitem]")].some(e=>e.textContent.includes("Complete review"))'
    ),
    false
  )
  await ui.named("Review again", '[role="menuitem"]')
  await ui.until(
    "!document.querySelector('main[aria-label=Review] > header')?.textContent.includes('Archived in Git')"
  )
  await menu()
  await ui.has("Local draft")
  await closeMenu()
  assert.deepEqual(
    await publicationIds(),
    [second],
    "reopening archive preserves publication"
  )
  assert.deepEqual(await ui.execute("return window.__uiErrors"), [])
  assert.deepEqual((await ui.layout()).overflow, [])
  await ui.screenshot("reopened-local-draft")
  console.log(
    "Native publication: local draft, explicit manual completion, keep-local, publication, refresh, first-commit archive, frozen reread and reopen passed"
  )
} catch (error) {
  await ui.screenshot("publication-failure").catch(() => {})
  console.error(await ui.text().catch(() => "No UI"))
  throw error
} finally {
  await ui.stop()
  await f.cleanup()
}
