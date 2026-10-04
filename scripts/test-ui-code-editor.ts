import assert from "node:assert/strict"
import { mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { fixture, NativeUI } from "../tests/native/ui-driver"

process.env.REVIEWBOX_NATIVE_ARTIFACTS ??= "artifacts/validation/code-editor"
const f = await fixture()
let ui = new NativeUI()
let phase = "open"
const tree = 'nav[aria-label="Project files"]'
const file = (path: string) => `${tree} [title=${JSON.stringify(path)}]`
const editor = 'section[aria-label="Project file"] .monaco-editor'
const disk = (path: string) => readFile(join(f.repo, path), "utf8")
const shortcut = async (key: string, shift = false) => {
  await ui.execute(
    `const e=document.activeElement;for(const type of ['keydown','keyup']) e.dispatchEvent(new KeyboardEvent(type,{key:arguments[0],code:'Key'+arguments[0].toUpperCase(),keyCode:arguments[0].toUpperCase().charCodeAt(0),which:arguments[0].toUpperCase().charCodeAt(0),metaKey:true,shiftKey:arguments[1],bubbles:true,cancelable:true}));return true`,
    [key, shift]
  )
}
const showsCode = (text: string) =>
  ui.until(
    `document.querySelector('section[aria-label="Project file"] .view-lines')?.textContent.replaceAll('\\u00a0',' ').includes(${JSON.stringify(text)})`
  )
const replace = async (text: string) => {
  await ui.until(
    "!document.querySelector('[role=dialog][data-open]')",
    "dialog closed"
  )
  await ui.execute(
    "for(const a of document.getAnimations())if(Number.isFinite(a.effect?.getComputedTiming().endTime))a.finish();return true"
  )
  await Bun.sleep(200)
  await ui.click(`${editor} .view-lines`)
  await ui.execute("document.querySelector(arguments[0]).focus();return true", [
    `${editor} textarea`,
  ])
  await ui.until("document.activeElement?.tagName==='TEXTAREA'", "editor focus")
  await shortcut("a")
  // WebDriver's value endpoint rewrites Monaco's hidden textarea. A paste event
  // follows the editor's actual input path and leaves its undo history intact.
  await ui.execute(
    `const data=new DataTransfer();data.setData('text/plain',arguments[0]);document.activeElement.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));return true`,
    [text]
  )
  await ui.has("Unsaved changes")
}
const context = async (path: string) => {
  await ui.execute(
    `const e=document.querySelector(arguments[0]);e.focus();const r=e.getBoundingClientRect();e.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:r.left+20,clientY:r.top+r.height/2}));return true`,
    [file(path)]
  )
  await ui.until("!!document.querySelector('[role=menu]')")
}
const open = async () => {
  await ui.named("or enter a path")
  await ui.fill('[aria-label="Repository path"]', f.repo)
  await ui.named("Open")
  await ui.named("Code Editor", "[role=tab]")
  await ui.element(tree)
}
try {
  await mkdir(join(f.repo, "empty"))
  await f.write(".gitignore", "ignored.txt\n")
  await f.write("ignored.txt", "ignored file")
  await ui.start(join(f.root, "appdata"))
  await ui.execute(`window.BASE_UI_ANIMATIONS_DISABLED=true;
    const frame=window.requestAnimationFrame.bind(window),cancel=window.cancelAnimationFrame.bind(window);
    window.requestAnimationFrame=cb=>document.hidden?-setTimeout(()=>cb(performance.now()),16):frame(cb);
    window.cancelAnimationFrame=id=>id<0?clearTimeout(-id):cancel(id);return true`)
  await open()
  await ui.element(`${tree} [data-folder="empty"]`)
  await ui.element(file("ignored.txt"))
  phase = "drafts and tabs"
  await ui.click(`${tree} [data-folder="src"]`)
  await ui.click(file("src/answer.ts"))
  await replace("export const answer = 99;\n")
  assert.equal(await disk("src/answer.ts"), "export const answer = 43;\n")
  await ui.click(file("src/other.ts"))
  await replace("export const other = 'edited';\n")
  await ui.named("Review", "[role=tab]")
  await ui.named("Code Editor", "[role=tab]")
  await ui.click('[role=tab][title="src/answer.ts"]')
  await showsCode("answer = 99")
  await ui.click(`${editor} .view-lines`)
  await shortcut("z")
  await showsCode("answer = 43")
  await shortcut("z", true)
  await showsCode("answer = 99")
  await shortcut("s")
  await ui.wait(
    async () => (await disk("src/answer.ts")).includes("99"),
    "manual save"
  )
  phase = "external conflict"
  await replace("export const answer = 100;\n")
  await f.write("src/answer.ts", "export const answer = 200;\n")
  await ui.has("This file changed outside ReviewBox.")
  await ui.named("Compare changes")
  await ui.has("Compare external changes")
  await ui.named("Keep my draft")
  assert.equal(await disk("src/answer.ts"), "export const answer = 200;\n")
  await ui.named("Compare changes")
  await ui.named("Replace disk version")
  await ui.wait(
    async () => (await disk("src/answer.ts")).includes("100"),
    "explicit overwrite"
  )
  phase = "rename dirty file"
  await replace("export const answer = 101;\n")
  await context("src/answer.ts")
  await ui.named("Rename", "[role=menuitem]")
  await ui.fill('[aria-label="File path"]', "src/renamed.ts")
  await ui.named("Rename", "[role=dialog] button")
  await ui.element('[role=tab][title="src/renamed.ts"]')
  await ui.named("Save", 'section[aria-label="Project file"] button')
  await ui.wait(
    async () => (await disk("src/renamed.ts")).includes("101"),
    "renamed buffer saved"
  )
  phase = "creation and trash"
  await ui.click('[aria-label="Create file or folder"]')
  await ui.named("New file", '[role="menuitem"]')
  await ui.fill('[aria-label="File path"]', "created.ts")
  await ui.named("New file", "[role=dialog] button")
  await replace("const draft = true;\n")
  await context("created.ts")
  await ui.named("Move to Trash", "[role=menuitem]")
  await ui.has("contains unsaved changes")
  await ui.named("Cancel", "[role=dialog] button")
  assert.equal(await disk("created.ts"), "")
  await context("created.ts")
  await ui.named("Move to Trash", "[role=menuitem]")
  await ui.named("Discard and move to Trash")
  await ui.until(`!document.querySelector('[role=tab][title="created.ts"]')`)
  await assert.rejects(() => disk("created.ts"))
  phase = "markdown and recovery"
  await ui.click(file("README.md"))
  await ui.has("Sample")
  await ui.named("Markdown preview")
  await replace("# Unsaved preview\n\nCurrent draft.\n")
  await ui.named("Markdown preview")
  await ui.has("Unsaved preview")
  assert(!(await disk("README.md")).includes("Unsaved preview"))
  await ui.named("Close README.md")
  await ui.has("Save changes?")
  await ui.named("Cancel", "[role=dialog] button")
  await Bun.sleep(650)
  await ui.screenshot("editing-and-preview")
  await ui.stop()
  ui = new NativeUI()
  await ui.start(join(f.root, "appdata"))
  await ui.execute(`window.BASE_UI_ANIMATIONS_DISABLED=true;
    const frame=window.requestAnimationFrame.bind(window),cancel=window.cancelAnimationFrame.bind(window);
    window.requestAnimationFrame=cb=>document.hidden?-setTimeout(()=>cb(performance.now()),16):frame(cb);
    window.cancelAnimationFrame=id=>id<0?clearTimeout(-id):cancel(id);return true`)
  await ui.named("sample-project", "button", false)
  await ui.named("Code Editor", "[role=tab]")
  await ui.has("Unsaved preview")
  phase = "auto save outside editor"
  await ui.named("Auto save", "label")
  await ui.named("Review", "[role=tab]")
  await ui.wait(
    async () => (await disk("README.md")).includes("Unsaved preview"),
    "auto save outside editor"
  )
  assert.equal(
    f.git("write-tree").trim(),
    f.index.trim(),
    "editor leaves Git index untouched"
  )
  await ui.named("Code Editor", "[role=tab]")
  await ui.screenshot("recovered-and-saved")
  const errors = await ui.execute<string[]>("return window.__uiErrors")
  assert.deepEqual(
    errors.filter((e) => !e.includes("ResizeObserver loop")),
    []
  )
  console.log(
    "Native Code Editor: tabs, undo, manual/auto save, conflicts, rename, creation/trash, Markdown drafts, crash recovery and Git index preservation passed."
  )
} catch (error) {
  await ui.screenshot(`failed-${phase.replaceAll(" ", "-")}`).catch(() => {})
  console.error(
    await ui.execute("return {errors:window.__uiErrors,hidden:document.hidden}")
  )
  throw new Error(`${phase}: ${error}`, { cause: error })
} finally {
  await ui.stop()
  await f.cleanup()
}
