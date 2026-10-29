import assert from "node:assert/strict"
import { readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fixture, NativeUI } from "../tests/native/ui-driver"

process.env.REVIEWBOX_NATIVE_PORT ??= "14486"
process.env.REVIEWBOX_NATIVE_ARTIFACTS ??=
  "artifacts/validation/review-comments"
const f = await fixture()
const ui = new NativeUI()
const notesPath = join(f.repo, ".reviewbox/.local/REVIEW_COMMENTS.md")
const sourceBefore = await readFile(join(f.repo, "src/answer.ts"), "utf8")
let phase = "open"
const captureEditors = async (name: string) => {
  const state = await ui.execute(`return {
    errors: window.__uiErrors ?? [],
    editors: Array.from(document.querySelectorAll('.block-diff, .block-diff-main, .block-diff-main > .monaco-editor, .block-zone-layer, .block-comparison, .block-column, .block-cell, .block-diff-main .view-line')).slice(0, 35).map(node => {
      const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
      return { className: node.className, text: node.textContent?.slice(0, 300),
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        display: style.display, visibility: style.visibility, opacity: style.opacity,
        inlineStyle: node.getAttribute('style'), comparing: node.dataset.comparing,
        replaced: node.dataset.allReplaced };
    })
  }`)
  await writeFile(
    join(ui.artifacts, `${name}.json`),
    JSON.stringify(state, null, 2)
  )
}
try {
  await ui.start(join(f.root, "appdata"))
  await ui.resize(1440, 900)
  await ui.named("or enter a path")
  await ui.fill('[aria-label="Repository path"]', f.repo)
  await ui.named("Open")
  await captureEditors("startup")
  await ui.startManualReview()
  if (
    await ui.execute(
      'return !!document.querySelector(\'[data-folder="src"][aria-expanded="false"]\')'
    )
  )
    await ui.click('[data-folder="src"][aria-expanded="false"]')
  await ui.click('[title="src/answer.ts"]')
  await ui.until(
    "Array.from(document.querySelectorAll('.block-after .view-line')).some(node => node.textContent.trim() && node.getBoundingClientRect().height > 0)",
    "visible source text"
  )
  await captureEditors("before-comparison")
  const select = async (side: "before" | "after") => {
    if (
      await ui.execute(
        "return !!document.querySelector('[aria-label=\"Show previous code\"]')"
      )
    )
      await ui.named("Show previous code")
    await captureEditors(`comparison-${side}`)
    await ui.click(`.block-${side} .view-line span`)
    // The native WebDriver click omits Monaco's pointer-down focus transfer.
    await ui.execute(
      `document.querySelector(arguments[0]).closest('.monaco-editor').querySelector('textarea').focus();return true`,
      [`.block-${side} .view-line span`]
    )
    await ui.shortcut("a")
    await ui.has("Add comment")
    await ui.named("Add comment")
  }
  phase = "after comment"
  await select("after")
  await ui.fill(
    '[aria-label="Review comment"]',
    "Handle the empty input before returning the answer."
  )
  await ui.named("Save comment")
  await ui.wait(
    async () =>
      (await readFile(notesPath, "utf8").catch(() => "")).includes(
        "Handle the empty input"
      ),
    "local comment written"
  )
  phase = "before comment"
  await select("before")
  await ui.fill(
    '[aria-label="Review comment"]',
    "Explain why the previous behaviour is no longer needed."
  )
  await ui.named("Save comment")
  await ui.named("End review")
  await ui.has("Comments for your agent")
  await ui.has("2 open")
  await ui.has("Prompt for your working agent")
  assert.equal(
    await readFile(join(f.repo, "src/answer.ts"), "utf8"),
    sourceBefore
  )
  assert.equal(f.git("write-tree"), f.index)
  assert.deepEqual(
    await readdir(join(f.repo, ".reviewbox/published")).catch(() => []),
    []
  )
  const notes = await readFile(notesPath, "utf8")
  assert(notes.includes(":before") && notes.includes(":after"))
  phase = "edit resolution"
  await ui.named("Edit comment")
  await ui.fill(
    '[aria-label="Comment resolution"]',
    "Retained the guard and clarified its intent."
  )
  await ui.fill(
    '[aria-label="Comment tests"]',
    "Manual source comparison only; no test execution."
  )
  await ui.named("Addressed", "label")
  await ui.named("Save comment")
  await ui.has("1 open")
  await ui.has("1 addressed")
  await ui.named("Back to review")
  await ui.has("End review")
  phase = "external edits"
  await writeFile(
    notesPath,
    `${(await readFile(notesPath, "utf8")).replace(
      "Explain why the previous behaviour is no longer needed.",
      "Externally clarified: explain why the previous behaviour is no longer needed."
    )}\nExternal prose must remain intact.\n`
  )
  await ui.named("End review")
  // Reload is also triggered by foreground reconciliation; user interaction remains UI-owned.
  await ui.execute("window.dispatchEvent(new Event('focus'));return true")
  await ui.has("Externally clarified:")
  await ui.named("Delete comment")
  await ui.has("0 addressed")
  await ui.wait(
    async () =>
      (await readFile(notesPath, "utf8")).includes(
        "External prose must remain intact."
      ),
    "external prose preserved"
  )
  const remaining = await readFile(notesPath, "utf8")
  assert.equal(remaining.match(/<!-- REVIEWBOX_START#/g)?.length, 1)
  assert(remaining.includes("Externally clarified:"))
  await ui.screenshot("manual-comment-handoff")
  assert.equal(
    await readFile(join(f.repo, "src/answer.ts"), "utf8"),
    sourceBefore
  )
  assert.equal(f.git("write-tree"), f.index)
  const errors = await ui.execute<string[]>("return window.__uiErrors ?? []")
  assert.deepEqual(
    errors.filter((error) => !error.includes("ResizeObserver loop")),
    []
  )
  console.log(
    "Native review comments: before/after selection, private Markdown, resolution/tests, handoff/back, external prose and source/index preservation passed."
  )
} catch (error) {
  await captureEditors(`failed-${phase.replaceAll(" ", "-")}`).catch(() => {})
  await ui.screenshot(`failed-${phase.replaceAll(" ", "-")}`).catch(() => {})
  throw error
} finally {
  await ui.stop()
  await f.cleanup()
}
