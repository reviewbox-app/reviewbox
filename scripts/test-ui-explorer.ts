import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { fixture, NativeUI } from "../tests/native/ui-driver"

process.env.REVIEWBOX_NATIVE_PORT ??= "14483"
process.env.REVIEWBOX_NATIVE_ARTIFACTS ??= "artifacts/validation/explorer"
const f = await fixture()
let ui = new NativeUI()
let phase = "open"
const tree = 'nav[aria-label="Project files"]'
const file = (path: string) => `${tree} [title=${JSON.stringify(path)}]`
const folder = (path: string) => `${tree} [data-folder=${JSON.stringify(path)}]`
const headerHeight = (selector: string) =>
  ui.execute<number>(
    "return document.querySelector(arguments[0]).getBoundingClientRect().height",
    [selector]
  )
try {
  await mkdir(join(f.repo, "many"))
  for (let i = 0; i < 80; i++)
    await f.write(
      `many/file-${String(i).padStart(3, "0")}.txt`,
      `sample ${i}\n`
    )
  await ui.start(join(f.root, "appdata"))
  await ui.execute("window.BASE_UI_ANIMATIONS_DISABLED=true;return true")
  await ui.named("or enter a path")
  await ui.fill('[aria-label="Repository path"]', f.repo)
  await ui.named("Open")
  await ui.named("Code Editor", "[role=tab]")
  await ui.element('main [data-slot="empty"]')
  await ui.element('main [data-slot="empty-content"] button')
  phase = "metadata visibility and compact identity"
  await ui.click(folder(".reviewbox"))
  await ui.click(file(".reviewbox/settings.json"))
  await ui.has("ReviewBox manages this file")
  assert.equal(
    await headerHeight('section[aria-label="Project file"] > header'),
    36
  )
  assert.equal(
    await ui.execute(
      "return getComputedStyle(document.querySelector('section[aria-label=\"Project file\"] header span.opacity-50')).opacity"
    ),
    "0.5"
  )
  await f.write(".reviewbox/CURRENT_CHANGES.md", "# Context\nFixture change.\n")
  await ui.click(file(".reviewbox/CURRENT_CHANGES.md"))
  await ui.has("Fixture change.")
  assert.equal(
    await headerHeight('section[aria-label="Project file"] > header'),
    36
  )
  await ui.click(folder("src"))
  await ui.click(file("src/answer.ts"))
  phase = "search preserves expansion"
  await ui.fill('[aria-label="Filter files"]', "other.ts")
  await ui.element(file("src/other.ts"))
  await ui.fill('[aria-label="Filter files"]', "")
  await ui.until(
    `document.querySelector(${JSON.stringify(folder("src"))})?.getAttribute('aria-expanded')==='true'`
  )
  await ui.click(folder("many"))
  await ui.execute(
    "const tree=document.querySelector(arguments[0]);tree.scrollTop=220;tree.dispatchEvent(new Event('scroll',{bubbles:true}));return true",
    [tree]
  )
  const scroll = await ui.execute<number>(
    "return document.querySelector(arguments[0]).scrollTop",
    [tree]
  )
  assert(scroll > 0)
  await Bun.sleep(500)
  phase = "restart restores private tree state"
  await ui.stop()
  ui = new NativeUI()
  await ui.start(join(f.root, "appdata"))
  await ui.named("sample-project", "button", false)
  await ui.named("Code Editor", "[role=tab]")
  await ui.until(
    `document.querySelector(${JSON.stringify(folder("src"))})?.getAttribute('aria-expanded')==='true'`
  )
  await ui.until(
    `Math.abs(document.querySelector(${JSON.stringify(tree)})?.scrollTop-${scroll})<2`
  )
  await ui.element('[role=tab][aria-selected="true"][title="src/answer.ts"]')
  phase = "live review modes and unchanged files"
  await ui.nativeMenu("Review", "View local changes")
  await ui.until(
    "document.querySelector('[aria-label=\"Review file mode\"]')?.textContent.includes('All files')"
  )
  await ui.click('nav[aria-label="Changed files"] [data-folder=".reviewbox"]')
  await ui.click(
    'nav[aria-label="Changed files"] [title=".reviewbox/settings.json"]'
  )
  await ui.until(
    "document.querySelector('section[aria-label=\"Unchanged source\"] .view-lines')?.textContent.includes('reviewbox')",
    "managed metadata remains inspectable in read-only viewer"
  )
  await ui.click('nav[aria-label="Changed files"] [title="README.md"]')
  await ui.element('section[aria-label="Unchanged source"]')
  assert.equal(
    await headerHeight('section[aria-label="Unchanged source"] > header'),
    36
  )
  await ui.click('[aria-label="Review file mode"]')
  await ui.named("Local changes", '[role="option"]')
  await ui.until(
    "document.querySelector('[aria-label=\"Review file mode\"]')?.textContent.includes('Local changes')"
  )
  await ui.named("Code Editor", "[role=tab]")
  await ui.nativeMenu("Review", "View local changes")
  await ui.until(
    "document.querySelector('[aria-label=\"Review file mode\"]')?.textContent.includes('Local changes')"
  )
  await ui.click('nav[aria-label="Changed files"] [title="src/answer.ts"]')
  await ui.element('section[aria-label="Code diff"]')
  assert.equal(
    await headerHeight('section[aria-label="Code diff"] > header'),
    36
  )
  assert.equal(f.git("write-tree").trim(), f.index.trim())
  const errors = await ui.execute<string[]>("return window.__uiErrors")
  assert.deepEqual(
    errors.filter((error) => !error.includes("ResizeObserver loop")),
    []
  )
  await ui.screenshot("explorer-persisted")
  console.log(
    "Native explorer: shared 36px headers, centered Empty, metadata visibility/protection, search restoration, restart with expansion/selection/scroll, All files and remembered Local changes, unchanged source inspection and Git index preservation passed."
  )
} catch (error) {
  await ui.screenshot(`failed-${phase.replaceAll(" ", "-")}`).catch(() => {})
  console.error({
    phase,
    diagnostics: await ui
      .execute(
        `return {
          focused: document.hasFocus(), visibility: document.visibilityState,
          errors: window.__uiErrors ?? [],
          dialogs: [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].map(e=>e.textContent),
          selectedTabs: [...document.querySelectorAll('[role="tab"][aria-selected="true"]')].map(e=>e.textContent),
          mode: document.querySelector('[aria-label="Review file mode"]')?.textContent ?? null,
          editors: [...document.querySelectorAll('.monaco-editor')].map(e=>({
            width:e.clientWidth, height:e.clientHeight, lines:e.querySelector('.view-lines')?.textContent
          }))
        }`
      )
      .catch(() => "unavailable"),
  })
  throw new Error(`${phase}: ${error}`, { cause: error })
} finally {
  await ui.stop()
  await f.cleanup()
}
