import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { NativeUI, fixture } from "../tests/native/ui-driver"
import { createPreparationHarness } from "../tests/native/preparation-fixture"
import { createLanguageHarness } from "../tests/native/language-fixture"

process.env.REVIEWBOX_NATIVE_PORT ??= "14462"
process.env.REVIEWBOX_NATIVE_ARTIFACTS ??= "artifacts/validation/code-colors"
const f = await fixture()
const ui = new NativeUI()
let originalTheme: "Dark" | "Light" | "System" | undefined
const harness = await createPreparationHarness(f.root, false, 2)
const lsp = await createLanguageHarness(f.root)
const source = `export function renderUser(userId: string): string {
  // neutral comment
  /** documentation */
  const state = { loading: false, label: "hello" };
  return state.loading ? "Loading..." : userId + "${"a readable value ".repeat(55)}";
}
`
await writeFile(harness.mode, "done")
await f.write("src/answer.ts", source)
f.git("add", "src/answer.ts")
await f.write("src/answer.ts", source.replace("hello", "updated"))

async function settings() {
  await ui.request(ui.route("/window"), { handle: "settings" })
}
async function main() {
  await ui.request(ui.route("/window"), { handle: "main" })
}
async function theme(name: "Dark" | "Light" | "System") {
  await settings()
  await ui.named("General", "nav button")
  await ui.named(name, '[role="tab"]')
  await main()
  if (name !== "System")
    await ui.until(
      `document.documentElement.classList.contains(${JSON.stringify(name.toLowerCase())})`
    )
}
const editorSelector = ".block-diff-main > .monaco-editor"
async function colors() {
  return ui.execute<string[]>(
    `return [...new Set([...document.querySelectorAll('${editorSelector} .view-line span')].filter(e=>e.textContent.trim()).map(e=>getComputedStyle(e).color))]`
  )
}

try {
  await ui.start(join(f.root, "appdata"))
  const storedTheme = await ui.execute<string | null>(
    "return localStorage.getItem('theme')"
  )
  originalTheme =
    storedTheme === "dark"
      ? "Dark"
      : storedTheme === "light"
        ? "Light"
        : "System"
  await ui.execute(`window.BASE_UI_ANIMATIONS_DISABLED=true;
    const frame=window.requestAnimationFrame.bind(window),cancel=window.cancelAnimationFrame.bind(window);
    window.requestAnimationFrame=callback=>document.hidden?-setTimeout(()=>callback(performance.now()),16):frame(callback);
    window.cancelAnimationFrame=id=>id<0?clearTimeout(-id):cancel(id);return true;`)
  await ui.named("Settings")
  await ui.wait(
    async () =>
      (await ui.request<string[]>(ui.route("/window/handles"))).includes(
        "settings"
      ),
    "settings"
  )
  await settings()
  await ui.named("Rev", "nav button")
  await ui.setHarnessExecutable("codex", harness.executable)
  await ui.setDefaultHarness("codex")
  await ui.named("Languages", "nav button")
  await ui.named("Custom executables")
  await ui.fill("#typescript-exe", lsp.executable)
  await ui.fill("#typescript-args", "")
  await ui.named("Save configuration")
  await ui.has("Configuration saved.")
  await main()
  await ui.named("or enter a path")
  await ui.fill('[aria-label="Repository path"]', f.repo)
  await ui.named("Open")
  await ui.has("Read your changes")
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
    "prepared colors fixture",
    120000
  )
  await ui.named("Start review")
  await ui.has("Step 1 of 2")
  await ui.named("Technical", '[aria-label="Reading mode"] [role="tab"]')
  await ui.named("Code", '[role="tab"]')
  await ui.until(
    `document.querySelector('${editorSelector} .view-lines:not(.line-delete)')?.textContent.includes('renderUser')`
  )
  await ui.wait(async () => (await colors()).length >= 5, "rich source colors")
  for (const name of ["Dark", "Light"] as const) {
    await theme(name)
    await ui.resize(1440, 900)
    await ui.wait(
      async () =>
        (await ui.execute<string>(
          `const comment=[...document.querySelectorAll('${editorSelector} .view-line span')].find(e=>!e.querySelector('span')&&e.textContent.includes('neutral'));return comment ? getComputedStyle(comment).color : null`
        )) === (name === "Dark" ? "rgb(145, 145, 145)" : "rgb(140, 140, 140)"),
      "captured source comment color"
    )
    for (const width of [1440, 800]) {
      await ui.resize(width, 900)
      await ui.until(
        `document.querySelectorAll('${editorSelector} .view-line').length > 4`,
        "source wraps without truncation"
      )
      assert.equal(
        await ui.execute(
          `return [...document.querySelectorAll('.block-diff-main .scrollbar.horizontal')].filter(e=>e.classList.contains('visible') && e.getBoundingClientRect().height>0 && getComputedStyle(e).opacity!=='0').length`
        ),
        0
      )
      assert.deepEqual((await ui.layout()).overflow, [])
      await ui.screenshot(`source-${name.toLowerCase()}-${width}`)
    }
  }
  await theme("Dark")
  await ui.resize(1440, 900)
  const tokyo = await colors()
  assert(tokyo.includes("rgb(187, 154, 247)"), JSON.stringify(tokyo))
  const background = await ui.execute<string>(
    `return getComputedStyle(document.querySelector('${editorSelector}.monaco-editor')).backgroundColor`
  )
  await settings()
  await ui.named("General", "nav button")
  await ui.select('[aria-label="Code font"]', "Menlo")
  await ui.select('[aria-label="Code font weight"]', "700 · Bold")
  await ui.select('[aria-label="Code theme"]', "ReviewBox")
  await main()
  await ui.until(
    `Array.from(document.querySelectorAll('.block-diff .view-lines')).every(e=>getComputedStyle(e).fontFamily.includes('Menlo')&&getComputedStyle(e).fontWeight==='700')`,
    "shared typography in main and comparison code"
  )
  await ui.wait(
    async () => (await colors()).includes("rgb(143, 176, 255)"),
    "ReviewBox code color preference applies to an existing editor"
  )
  assert.equal(
    await ui.execute(
      `return getComputedStyle(document.querySelector('${editorSelector}.monaco-editor')).backgroundColor`
    ),
    background
  )
  await settings()
  await ui.select('[aria-label="Code theme"]', "Tokyo Night")
  await main()
  await ui.wait(
    async () => (await colors()).includes("rgb(187, 154, 247)"),
    "Tokyo Night restored"
  )

  // Definitions remain available through the editor shortcut, outside display options.
  await ui.execute(`const input=document.querySelector('${editorSelector} textarea');
    input.focus();input.dispatchEvent(new KeyboardEvent('keydown',{
      key:'F12',code:'F12',keyCode:123,which:123,bubbles:true,cancelable:true
    }));return true`)
  await ui.has("Definitions")
  await ui.until(
    'document.querySelectorAll("[aria-label=\\"Source locations\\"] button").length === 2',
    "all definition locations remain available"
  )
  await ui.named("src/other.ts:1", '[aria-label="Source locations"] button')
  await ui.until(
    'document.querySelector("[role=dialog] .view-lines")?.textContent.includes("other")'
  )
  await ui.until(
    `getComputedStyle(document.querySelector('[role=dialog] .view-lines')).fontFamily.includes('Menlo')&&getComputedStyle(document.querySelector('[role=dialog] .view-lines')).fontWeight==='700'`,
    "new captured exploration inherits code typography"
  )
  const captured = await ui.execute<string>(
    'return document.querySelector("[role=dialog] .view-lines").textContent'
  )
  await f.write(
    "src/other.ts",
    "export const other = 'LIVE FILE MUST NOT APPEAR';\n"
  )
  await ui.click("[role=dialog] .view-lines .view-line span")
  await ui.keys("x")
  assert.equal(
    await ui.execute(
      'return document.querySelector("[role=dialog] .view-lines").textContent'
    ),
    captured,
    "exploration stays read-only and captured"
  )
  assert(
    (await ui.text()).includes("Step 1 of 2"),
    "exploration does not change guided selection"
  )
  await ui.screenshot("multiple-captured-definitions")
  await ui.keys("\uE00C")
  const methods = (await readFile(lsp.calls, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).method)
  assert(methods.includes("textDocument/semanticTokens/full"))
  assert(methods.includes("textDocument/definition"))
  assert.deepEqual(await ui.execute("return window.__uiErrors"), [])
  console.log(
    "Native code colors: Tokyo Night/ReviewBox, light/dark comments, shared typography, wrapping, Material headers, snapshot LSP and multiple read-only definitions passed."
  )
} catch (error) {
  console.error(await readFile(lsp.calls, "utf8").catch(() => "No LSP call"))
  console.error(await ui.text().catch(() => "WebView unavailable"))
  console.error(
    await ui
      .execute(
        `return [...document.querySelectorAll('.monaco-editor, .monaco-diff-editor, .view-lines')].map(e=>({tag:e.tagName,class:e.className,parent:e.parentElement.className,font:getComputedStyle(e).fontFamily,weight:getComputedStyle(e).fontWeight,text:e.classList.contains('view-lines')?e.textContent.slice(0,150):''}))`
      )
      .catch(() => [])
  )
  console.error(await ui.execute("return window.__uiErrors").catch(() => []))
  await ui.screenshot("failure").catch(() => {})
  throw error
} finally {
  if (originalTheme) await theme(originalTheme).catch(() => {})
  await ui.stop()
  await f.cleanup()
}
