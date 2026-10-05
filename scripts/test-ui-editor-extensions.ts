import assert from "node:assert/strict"
import { cp, mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { NativeUI, fixture } from "../tests/native/ui-driver"
process.env.REVIEWBOX_NATIVE_PORT ??= "14468"
process.env.REVIEWBOX_NATIVE_ARTIFACTS ??=
  "artifacts/validation/editor-extensions"
const f = await fixture(),
  ui = new NativeUI(),
  data = join(f.root, "appdata")
let phase = "open editor"
let originalTheme: "Dark" | "Light" | "System" | undefined
const source =
  '// neutral comment\n/** documentation */\nexport const colors = { nested: ["#abcdef", "oklch(70% .12 180)"] };\n'
async function main() {
  await ui.request(ui.route("/window"), { handle: "main" })
}
async function settings() {
  await ui.request(ui.route("/window"), { handle: "settings" })
}
async function backgroundFrames() {
  // The driver selects a WebView without bringing its NSWindow to the foreground.
  // Keep rendering while the test switches between the two actual native windows.
  await ui.execute(
    `window.BASE_UI_ANIMATIONS_DISABLED=true;window.requestAnimationFrame=cb=>setTimeout(()=>cb(performance.now()),16);window.cancelAnimationFrame=clearTimeout;window.requestIdleCallback=cb=>setTimeout(()=>cb({didTimeout:false,timeRemaining:()=>50}),0);window.cancelIdleCallback=clearTimeout;return true`
  )
}
async function choose(label: string, value: string) {
  await ui.click(`[aria-label="${label}"]`)
  await ui.named(value, "[role=option]", false)
}
const editorText = () =>
  ui.execute<string>(
    `return [...document.querySelectorAll('section[aria-label="Project file"] .view-line')].map(e=>e.textContent.replaceAll('\\u00a0',' ')).join('\\n')`
  )
async function replace(text: string) {
  await ui.click('section[aria-label="Project file"] .view-lines')
  await ui.execute(
    `document.querySelector('section[aria-label="Project file"] textarea').focus();return true`
  )
  await ui.shortcut("a")
  await ui.execute(
    `const data=new DataTransfer();data.setData('text/plain',arguments[0]);document.activeElement.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));return true`,
    [text]
  )
  await ui.has("Unsaved changes")
}
const color = () =>
  ui.execute<string>(
    `return getComputedStyle([...document.querySelectorAll('section[aria-label="Project file"] .view-line span')].find(e=>!e.querySelector('span') && e.textContent.includes('neutral'))).color`
  )
try {
  await f.write("editor.ts", source)
  await f.write("tags.xml", "<root><node><nested /></node></root>\n")
  await f.write("shader.glsl", "void main() { gl_Position = vec4(1.0); }\n")
  await f.write("format.ts", "// original\n")
  await f.write(".prettierrc.json", '{"semi":false,"singleQuote":true}\n')
  if (process.env.REVIEWBOX_LANGUAGE_SMOKE_DIR) {
    await mkdir(join(data, "language-servers"), { recursive: true })
    await cp(
      join(process.env.REVIEWBOX_LANGUAGE_SMOKE_DIR, "language-servers/state"),
      join(data, "language-servers/state"),
      { recursive: true }
    )
  }
  await ui.start(data)
  await backgroundFrames()
  const initialTheme = await ui.execute<string | null>(
    "return localStorage.getItem('theme')"
  )
  originalTheme =
    initialTheme === "dark"
      ? "Dark"
      : initialTheme === "light"
        ? "Light"
        : "System"
  await ui.named("or enter a path")
  await ui.fill('[aria-label="Repository path"]', f.repo)
  await ui.named("Open")
  await ui.named("Code Editor", "[role=tab]")
  await ui.click('nav[aria-label="Project files"] [title="editor.ts"]')
  await ui.has("Language support active")
  await ui.until(
    `document.querySelectorAll('section[aria-label="Project file"] .view-line span[class*="rb-color-"]').length > 0`,
    "color backgrounds"
  )
  await ui.named("Settings")
  await ui.wait(
    async () =>
      (await ui.request<string[]>(ui.route("/window/handles"))).includes(
        "settings"
      ),
    "settings window"
  )
  await settings()
  await backgroundFrames()
  assert(!(await ui.text()).includes("Import VS Code"))
  await ui.named("General", "nav button")
  await choose("Code theme", "Tokyo Night")
  await ui.named("Dark", "[role=tab]")
  await main()
  await ui.until(`document.documentElement.classList.contains('dark')`)
  await ui.wait(
    async () => (await color()) === "rgb(145, 145, 145)",
    "half opacity comments"
  )
  await ui.screenshot("tokyo-night-dark")
  phase = "font and weight across windows"
  await settings()
  await choose("Code font", "Menlo")
  await choose("Code font weight", "700")
  await main()
  await ui.until(
    `getComputedStyle(document.querySelector('section[aria-label="Project file"] .view-lines')).fontFamily.includes('Menlo')`,
    "font applied"
  )
  await ui.until(
    `getComputedStyle(document.querySelector('section[aria-label="Project file"] .view-lines')).fontWeight==='700'`,
    "weight applied"
  )
  phase = "extension toggles"
  await settings()
  await ui.named("Extensions", "nav button")
  assert.equal(
    await ui.execute(
      `return document.querySelectorAll('[role=switch]').length`
    ),
    12
  )
  await ui.click('[aria-label="Color Highlight"]')
  await main()
  await ui.until(
    `document.querySelectorAll('section[aria-label="Project file"] .view-line span[class*="rb-color-"]').length===0`,
    "colors removed"
  )
  await settings()
  await ui.click('[aria-label="Color Highlight"]')
  await main()
  await ui.until(
    `document.querySelectorAll('section[aria-label="Project file"] .view-line span[class*="rb-color-"]').length>0`,
    "colors restored"
  )
  await settings()
  await ui.click('[aria-label="Bracket Pair Colorization"]')
  await main()
  await ui.until(
    `document.querySelectorAll('section[aria-label="Project file"] .bracket-highlighting-0').length===0`,
    "brackets disabled"
  )
  await settings()
  await ui.click('[aria-label="Bracket Pair Colorization"]')
  await main()
  await ui.until(
    `document.querySelectorAll('section[aria-label="Project file"] [class*="bracket-highlighting-"]').length>0`,
    "brackets restored"
  )
  await settings()
  await ui.screenshot("extensions-settings")
  phase = "light theme"
  await ui.named("General", "nav button")
  await ui.named("Light", "[role=tab]")
  await main()
  await ui.wait(
    async () => (await color()) === "rgb(140, 140, 140)",
    "light comments"
  )
  await ui.screenshot("tokyo-night-light")
  phase = "Prettier save and Undo"
  await ui.click('nav[aria-label="Project files"] [title="format.ts"]')
  await replace('const message={text:"hello"};\n')
  await ui.shortcut("s")
  await ui.wait(
    async () =>
      (await readFile(join(f.repo, "format.ts"), "utf8")) ===
      "const message = { text: 'hello' }\n",
    "Prettier save"
  )
  await ui.shortcut("z")
  await ui.wait(
    async () => (await editorText()).includes('const message={text:"hello"};'),
    "format Undo preserves typing"
  )
  await ui.shortcut("z", true)
  await ui.wait(
    async () =>
      (await editorText()).includes("const message = { text: 'hello' }"),
    "format Redo"
  )
  phase = "XML paired editing and Undo"
  await ui.click('nav[aria-label="Project files"] [title="tags.xml"]')
  await ui.until(
    `document.querySelector('section[aria-label="Project file"] .view-lines')?.textContent.includes('<root><node>')`,
    "XML model mounted"
  )
  await ui.execute(
    `document.querySelector('section[aria-label="Project file"] textarea.inputarea').focus();return true`
  )
  await ui.shortcut("a")
  // WDIO's special keys omit keyCode, which Monaco's keyboard mapper requires.
  await ui.execute(
    `const input=document.activeElement;for(const [key,keyCode] of [['ArrowLeft',37],...Array.from({length:8},()=>['ArrowRight',39])])for(const type of ['keydown','keyup'])input.dispatchEvent(new KeyboardEvent(type,{key,code:key,keyCode,which:keyCode,bubbles:true,cancelable:true}));return true`
  )
  // Monaco debounces linked ranges for up to 200ms after a cursor move.
  await Bun.sleep(250)
  await ui.execute(
    `const data=new DataTransfer();data.setData('text/plain','i');document.activeElement.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));return true`
  )
  await ui.wait(
    async () =>
      /<root><(\w{5})><nested \/><\/\1><\/root>/.test(await editorText()),
    "initial paired XML edit"
  )
  await ui.shortcut("z")
  await ui.wait(
    async () => (await editorText()).includes("<node><nested /></node>"),
    "initial paired Undo"
  )
  await settings()
  await ui.named("Extensions", "nav button")
  await ui.click('[aria-label="Auto Rename Tag"]')
  await ui.until(
    `document.querySelector('[aria-label="Auto Rename Tag"]').getAttribute('aria-checked')==='false'`
  )
  await main()
  await ui.until(
    `!document.querySelector('.linked-editing-decoration')`,
    "linked editing disabled"
  )
  await ui.execute(
    `document.querySelector('section[aria-label="Project file"] textarea.inputarea').focus();const data=new DataTransfer();data.setData('text/plain','i');document.activeElement.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));return true`
  )
  await ui.wait(
    async () =>
      /<root><\w{5}><nested \/><\/node><\/root>/.test(await editorText()),
    "disabled tag editing leaves the closing tag unchanged"
  )
  await ui.shortcut("z")
  await ui.wait(
    async () => (await editorText()).includes("<node><nested /></node>"),
    "single tag edit undone"
  )
  await settings()
  await ui.click('[aria-label="Auto Rename Tag"]')
  await ui.until(
    `document.querySelector('[aria-label="Auto Rename Tag"]').getAttribute('aria-checked')==='true'`
  )
  await main()
  await Bun.sleep(250)
  await ui.execute(
    `document.querySelector('section[aria-label="Project file"] textarea.inputarea').focus();return true`
  )
  await ui.execute(
    `const data=new DataTransfer();data.setData('text/plain','i');document.activeElement.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));return true`
  )
  await ui.wait(
    async () =>
      /<root><(\w{5})><nested \/><\/\1><\/root>/.test(await editorText()),
    "both tags renamed"
  )
  await ui.screenshot("paired-xml-edit")
  await ui.shortcut("z")
  await ui.wait(
    async () => (await editorText()).includes("<node><nested /></node>"),
    "both tag edits undone together"
  )
  phase = "shader syntax enabled after opening"
  await settings()
  await ui.click('[aria-label="Shaders"]')
  await ui.until(
    `document.querySelector('[aria-label="Shaders"]').getAttribute('aria-checked')==='false'`
  )
  await main()
  await ui.click('nav[aria-label="Project files"] [title="shader.glsl"]')
  await ui.until(
    `document.querySelector('.view-lines')?.textContent.includes('gl_Position')`
  )
  await settings()
  await ui.click('[aria-label="Shaders"]')
  await ui.until(
    `document.querySelector('[aria-label="Shaders"]').getAttribute('aria-checked')==='true'`
  )
  await main()
  await ui.until(
    `Array.from(document.querySelectorAll('.view-line span')).some(e=>e.textContent==='void')`,
    "shader grammar loaded immediately"
  )
  const runtimeErrors = await ui.execute<string[]>(
    "return window.__uiErrors ?? []"
  )
  if (runtimeErrors.length) console.warn("WebView events:", runtimeErrors)
  assert.deepEqual(
    runtimeErrors.filter((error) => error !== "Canceled: Canceled"),
    []
  )
  await settings()
  await ui.click('[aria-label="npm IntelliSense"]')
  await ui.until(
    `document.querySelector('[aria-label="npm IntelliSense"]').getAttribute('aria-checked')==='false'`
  )
  phase = "restart persistence"
  await ui.stop()
  await ui.start(data)
  await backgroundFrames()
  await ui.named("Settings")
  await ui.wait(
    async () =>
      (await ui.request<string[]>(ui.route("/window/handles"))).includes(
        "settings"
      ),
    "settings reopen"
  )
  await settings()
  await backgroundFrames()
  await ui.named("General", "nav button")
  await ui.has("Menlo")
  await ui.has("700")
  await ui.until(
    `Array.from(document.querySelectorAll('[aria-label="Code font preview"] span')).some(e=>e.textContent.includes('// ReviewBox')&&getComputedStyle(e).color==='rgb(140, 140, 140)')`,
    "font preview shares the code theme"
  )
  await ui.screenshot("code-appearance")
  await ui.named("Extensions", "nav button")
  assert.equal(
    await ui.execute(
      `return document.querySelector('[aria-label="Color Highlight"]').getAttribute('aria-checked')`
    ),
    "true"
  )
  assert.equal(
    await ui.execute(
      `return document.querySelector('[aria-label="npm IntelliSense"]').getAttribute('aria-checked')`
    ),
    "false"
  )
  console.log(
    "Native extension settings, comments, fonts, weights, color/bracket/tag/shader toggles, Prettier, paired XML Undo and restart persistence: passed"
  )
} catch (error) {
  console.error("Phase:", phase)
  await ui.screenshot("failure").catch(() => {})
  console.error(await ui.text().catch(() => ""))
  console.error(
    await ui
      .execute(
        `return {errors:window.__uiErrors,hidden:document.hidden,active:document.activeElement?.tagName,input:[...document.querySelectorAll('textarea.inputarea')].map(e=>({value:e.value,start:e.selectionStart,end:e.selectionEnd})),lines:[...document.querySelectorAll('.view-line')].map(e=>e.innerHTML)}`
      )
      .catch(() => "")
  )
  throw error
} finally {
  if (originalTheme)
    await settings()
      .then(async () => {
        await ui.named("General", "nav button")
        await ui.named(originalTheme!, "[role=tab]")
      })
      .catch(() => {})
  await ui.stop()
  await f.cleanup()
}
