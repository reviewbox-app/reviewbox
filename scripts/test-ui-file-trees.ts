import assert from "node:assert/strict"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { NativeUI, fixture } from "../tests/native/ui-driver"

process.env.REVIEWBOX_NATIVE_PORT ??= "14478"
process.env.REVIEWBOX_NATIVE_ARTIFACTS ??= "artifacts/validation/file-trees"
const f = await fixture()
const ui = new NativeUI()
await writeFile(join(f.repo, ".git/info/exclude"), ".reviewbox/\n")
await mkdir(join(f.repo, "ready"))
await f.write("ready/only.ts", "export const ready = 1;\n")
await f.write("src/deleted.ts", "export const removed = true;\n")
f.git("add", "ready/only.ts", "src/deleted.ts")
f.git(
  "commit",
  "--only",
  "ready/only.ts",
  "src/deleted.ts",
  "-m",
  "Tree fixture"
)
await f.write("ready/only.ts", "export const ready = 2;\n")
f.git("add", "ready/only.ts")
await rm(join(f.repo, "src/deleted.ts"))
// Ensure selection centering is exercised in a genuinely scrollable tree.
for (const prefix of ["a-fixture", "z-fixture"]) {
  for (let i = 0; i < 25; i++)
    await f.write(
      `src/${prefix}-${String(i).padStart(2, "0")}.ts`,
      "export const value = 1;\n"
    )
}
await f.write("notes.TXT", "# Notes\nFirst line\nSecond **line**\n")
const context = async (selector: string, keyboard = false) => {
  await ui.execute(
    `const e=document.querySelector(arguments[0]); e.focus(); const r=e.getBoundingClientRect(); e.dispatchEvent(${keyboard ? "new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true,cancelable:true})" : "new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:r.left+20,clientY:r.top+r.height/2})"});return true`,
    [selector]
  )
  await ui.until("!!document.querySelector('[role=menu]')")
}
const menu = async (name: string) => {
  await ui.until(
    `[...document.querySelectorAll('[role=menuitem]')].some(e=>e.textContent.trim()===${JSON.stringify(name)} && !e.hasAttribute('data-disabled') && e.getAttribute('aria-disabled')!=='true')`,
    `enabled menu: ${name}`
  )
  await ui.named(name, '[role="menuitem"]')
}
const readOnlyMenu = async (selector: string, keyboard = false) => {
  await context(selector, keyboard)
  assert.deepEqual(
    await ui.execute(
      `return [...document.querySelectorAll('[role=menuitem]')].map(e=>e.textContent.trim())`
    ),
    ["Copy path", "Reveal in Finder"]
  )
}
const editorMenu = async (selector: string, folder = false) => {
  await context(selector, folder)
  assert.deepEqual(
    await ui.execute(
      `return [...document.querySelectorAll('[role=menuitem]')].map(e=>e.textContent.trim())`
    ),
    [
      "Copy path",
      "Reveal in Finder",
      ...(folder ? ["New file", "New folder"] : []),
      "Rename",
      "Move to Trash",
    ]
  )
}
const foldersOpaque = async (selector: string) =>
  assert(
    await ui.execute(
      `return [...document.querySelectorAll(arguments[0]+' [data-folder]')].every(e=>getComputedStyle(e).opacity==='1' && !e.querySelector('[data-git-status]'))`,
      [selector]
    )
  )
try {
  await ui.start(join(f.root, "appdata"))
  await ui.execute(`window.BASE_UI_ANIMATIONS_DISABLED=true;
    const frame=window.requestAnimationFrame.bind(window),cancel=window.cancelAnimationFrame.bind(window);
    window.requestAnimationFrame=callback=>document.hidden?-setTimeout(()=>callback(performance.now()),16):frame(callback);
    window.cancelAnimationFrame=id=>id<0?clearTimeout(-id):cancel(id);return true`)
  await ui.named("or enter a path")
  await ui.fill('[aria-label="Repository path"]', f.repo)
  await ui.named("Open")
  await ui.has("Read your changes")
  await ui.startManualReview()
  await ui.until(
    '!!document.querySelector(\'nav[aria-label="Review files"] [title="src/answer.ts"]\')'
  )
  const review = 'nav[aria-label="Review files"]'
  await ui.click(`${review} [title="src/other.ts"]`)
  await ui.until(
    `(()=>{const tree=document.querySelector('${review}'),row=tree.querySelector('[aria-current=page]'),r=row.getBoundingClientRect(),b=tree.getBoundingClientRect();return tree.scrollHeight>tree.clientHeight && Math.abs((r.top+r.bottom-b.top-b.bottom)/2)<2})()`,
    "selected file centered"
  )
  await ui.execute(
    `document.querySelector('${review}').scrollTop=0;return true`
  )
  await Bun.sleep(1200)
  assert.equal(
    await ui.execute(`return document.querySelector('${review}').scrollTop`),
    0,
    "passive refresh keeps manual scroll"
  )
  const selected = await ui.execute(
    `return document.querySelector('${review} [aria-current=page]')?.getAttribute('title')`
  )
  await readOnlyMenu(`${review} [title="src/deleted.ts"]`)
  await menu("Reveal in Finder")
  await ui.until("!document.querySelector('[role=menu]')")
  assert(
    !(await ui.execute(
      `return [...document.querySelectorAll('[role=alert]')].some(e=>e.textContent.trim())`
    )),
    "deleted source reveals its existing parent"
  )
  await readOnlyMenu(`${review} [data-folder="src"]`, true)
  await ui.keys("\uE00C")
  assert.equal(
    await ui.execute(
      `return document.querySelector('${review} [aria-current=page]')?.getAttribute('title')`
    ),
    selected
  )
  await foldersOpaque(review)
  const reviewStyle = await ui.execute(
    `const row=document.querySelector('${review} [title="src/answer.ts"]'), badge=row.querySelector('[data-git-status]');return {color:getComputedStyle(badge).color,opacity:getComputedStyle(badge).opacity}`
  )
  await ui.screenshot("review-tree")
  await ui.named("Code Editor", "[role=tab]")
  const explain = 'nav[aria-label="Project files"]'
  assert(
    await ui.execute(
      `return ![...document.querySelectorAll('[role=tab]')].some(e=>['Files','Tours','Glossary'].includes(e.textContent.trim()))`
    ),
    "Code Editor exposes only the file browser"
  )
  await ui.until(`!!document.querySelector('${explain} [data-folder="src"]')`)
  assert.equal(
    await ui.execute(
      `return document.querySelector('${explain} [data-folder="src"]').getAttribute('aria-expanded')`
    ),
    "false"
  )
  await editorMenu(`${explain} [data-folder="src"]`, true)
  await ui.keys("\uE00C")
  assert.equal(
    await ui.execute(
      `return document.querySelector('${explain} [data-folder="src"]').getAttribute('aria-expanded')`
    ),
    "false"
  )
  await ui.click(`${explain} [data-folder="src"]`)
  await ui.click(`${explain} [title="src/answer.ts"]`)
  await editorMenu(`${explain} [title="src/other.ts"]`)
  await ui.keys("\uE00C")
  assert.equal(
    await ui.execute(
      `return document.querySelector('${explain} [aria-current=page]')?.getAttribute('title')`
    ),
    "src/answer.ts"
  )
  assert.deepEqual(
    await ui.execute(
      `const row=document.querySelector('${explain} [title="src/answer.ts"]'), badge=row.querySelector('[data-git-status]');return {color:getComputedStyle(badge).color,opacity:getComputedStyle(badge).opacity}`
    ),
    reviewStyle
  )
  await foldersOpaque(explain)
  await ui.screenshot("explain-tree")
  await ui.click(`${explain} [title="README.md"]`)
  const preview = '[aria-label="Markdown file"]'
  await ui.until(
    `document.querySelector('${preview} h1')?.textContent==='Sample'`
  )
  assert.equal(
    await ui.execute(
      `return document.querySelector('[aria-label="Markdown preview"]').getAttribute('aria-pressed')`
    ),
    "true"
  )
  await ui.named("Find in file")
  await ui.fill('[aria-label="Find in document"]', "explanations")
  await ui.until(
    `document.querySelector('[role=search] [role=status]')?.textContent==='1 / 1'`
  )
  await ui.named("Close document search")
  await ui.execute(
    `document.querySelector('[aria-label="Markdown preview"]').focus();return true`
  )
  // Native WebDriver sends Enter without synthesizing button activation.
  // Browser tests cover Enter; native verifies focus and the actual click.
  assert.equal(
    await ui.execute(
      `return document.activeElement?.getAttribute("aria-label")`
    ),
    "Markdown preview"
  )
  await ui.named("Markdown preview")
  await ui.until(
    `[...document.querySelectorAll('.monaco-editor .view-lines')].some(e=>e.textContent.includes('Sample'))`
  )
  assert.equal(
    await ui.execute(
      `return document.querySelectorAll('.monaco-editor').length`
    ),
    1
  )
  await ui.click(`${explain} [title="notes.TXT"]`)
  await ui.until(
    `document.querySelector('${preview} h1')?.textContent==='Notes'`
  )
  assert.equal(
    await ui.execute(
      `return document.querySelectorAll('${preview} br').length`
    ),
    1
  )
  assert.equal(
    await ui.execute(
      `return document.querySelector('${preview} strong')?.textContent`
    ),
    "line"
  )
  await ui.screenshot("explain-markdown-text")
  await ui.click(`${explain} [title="README.md"]`)
  await ui.until(
    `document.querySelector('[aria-label="Markdown preview"]')?.getAttribute('aria-pressed')==='false'`
  )
  await ui.named("Markdown preview")
  await ui.until(
    `document.querySelector('${preview} h1')?.textContent==='Sample'`
  )

  await ui.named("Review", "[role=tab]")
  // Clicking Review again returns to the overview.
  await ui.named("Review", "[role=tab]")
  await ui.named("View local changes")
  const local = '[aria-label="Local files"]'
  await ui.until(`!!document.querySelector('${local} [data-folder="ready"]')`)
  await foldersOpaque(local)
  assert.equal(
    await ui.execute(
      `return getComputedStyle(document.querySelector('[aria-label="Staged files"] [title="ready/only.ts"] > span')).opacity`
    ),
    "0.5"
  )
  await context('[aria-label="Staged files"] [data-folder="ready"]', true)
  assert.deepEqual(
    await ui.execute(
      `return [...document.querySelectorAll('[role=menuitem]')].map(e=>e.textContent.trim())`
    ),
    ["Unstage folder", "Copy path", "Reveal in Finder", "Revert changes"]
  )
  await menu("Unstage folder")
  await ui.until(
    `!!document.querySelector('[aria-label="Unstaged files"] [title="ready/only.ts"]')`
  )
  await context('[aria-label="Unstaged files"] [data-folder="ready"]')
  await menu("Stage folder")
  await ui.until(
    `!!document.querySelector('[aria-label="Staged files"] [title="ready/only.ts"]')`
  )
  await ui.click('[aria-label="Unstaged files"] [title="src/other.ts"]')
  await ui.execute(
    `document.querySelector('[aria-label="Unstaged files"] [title="src/new.ts"]').dispatchEvent(new MouseEvent('click',{bubbles:true,metaKey:true}));return true`
  )
  await context('[aria-label="Unstaged files"] [title="src/new.ts"]')
  await menu("Stage 2 files")
  await ui.until(
    `document.querySelectorAll('[aria-label="Staged files"] [title="src/other.ts"],[aria-label="Staged files"] [title="src/new.ts"]').length===2`
  )
  assert(f.git("diff", "--cached", "--name-only").includes("src/new.ts"))
  await context('[aria-label="Unstaged files"] [title="src/deleted.ts"]')
  await menu("Revert changes")
  await ui.has("Revert unstaged changes?")
  await ui.named("Cancel", '[role="alertdialog"] button')
  assert(
    !(await Bun.file(join(f.repo, "src/deleted.ts")).exists()),
    "cancel preserves local deletion"
  )
  await foldersOpaque(local)
  await ui.screenshot("local-tree")
  assert.deepEqual(
    (await ui.execute<string[]>("return window.__uiErrors")).filter(
      (e) =>
        e !== "ResizeObserver loop completed with undelivered notifications."
    ),
    []
  )
  console.log(
    "Native shared trees: Review path menus and Code Editor file operations, keyboard, stable selection, deleted-path Finder, identical badges, opaque folders, local staging/multi-selection and revert cancellation; Code Editor Markdown/text defaults, focusable toggle, search and retained preferences passed."
  )
} catch (error) {
  await ui.screenshot("failure").catch(() => {})
  console.error(await ui.text().catch(() => ""))
  throw error
} finally {
  await ui.stop()
  await f.cleanup()
}
