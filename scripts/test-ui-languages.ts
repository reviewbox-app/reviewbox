import assert from "node:assert/strict"
import { join } from "node:path"
import catalogue from "../resources/languages/catalogue.json"
import { NativeUI, fixture } from "../tests/native/ui-driver"

const f = await fixture()
const ui = new NativeUI()
let phase = "open settings"
let originalTheme: string | null = null
const appearance = () => {
  // macOS's older sqlite3 CLI and Bun's readonly opener reject a WAL database
  // without sidecars. Python's SQLite handles that read-only connection correctly.
  const result = Bun.spawnSync(
    [
      "python3",
      "-c",
      `import json,sqlite3,sys
from urllib.parse import quote
with sqlite3.connect('file:'+quote(sys.argv[1])+'?mode=ro',uri=True) as db:
 row=db.execute("SELECT body FROM documents WHERE kind='appearance' AND id='preferences'").fetchone()
 value=json.loads(row[0]) if row else None
 print(json.dumps({'codeTheme':value['codeTheme'],'revision':value['revision']} if value else None))`,
      join(f.root, "appdata", "reviewbox.sqlite3"),
    ],
    { stdout: "pipe", stderr: "pipe" }
  )
  if (result.exitCode !== 0)
    throw new Error(`Read-only appearance probe: ${result.stderr.toString()}`)
  return JSON.parse(result.stdout.toString()) as {
    codeTheme: string
    revision: number
  } | null
}
const mark = (next: string) => {
  phase = next
  console.log(`Native settings: ${phase}`)
}
const selectedCodeTheme = (name: string) =>
  `document.querySelector('[aria-label="Code theme"]')?.textContent.includes(${JSON.stringify(name)})`
const waitCodeTheme = async (name: string, value: string) => {
  await ui.until(selectedCodeTheme(name), `${phase}: ${name} selected`)
  // Verify acknowledged native persistence before destroying its owner window.
  // This is read-only fixture observation, never a shortcut for a product action.
  await ui.wait(
    async () => appearance()?.codeTheme === value,
    `${phase}: ${value} persisted`
  )
  console.log(`Native settings persisted: ${JSON.stringify(appearance())}`)
}
const openSettings = async () => {
  await ui.named("Settings")
  await ui.wait(
    async () =>
      (await ui.request<string[]>(ui.route("/window/handles"))).includes(
        "settings"
      ),
    "settings window"
  )
  await ui.request(ui.route("/window"), { handle: "settings" })
  await ui.has("Code theme")
  await ui.execute(`window.BASE_UI_ANIMATIONS_DISABLED=true;
    if(!window.__settingsFrames){
      const frame=window.requestAnimationFrame.bind(window),cancel=window.cancelAnimationFrame.bind(window);
      window.requestAnimationFrame=callback=>document.hidden?-setTimeout(()=>callback(performance.now()),16):frame(callback);
      window.cancelAnimationFrame=id=>id<0?clearTimeout(-id):cancel(id);
      window.__settingsFrames=true;
    } return true`)
}
const row = (id: string) => `[data-server-id="${id}"]`
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
  await ui.named("or enter a path")
  await ui.fill('[aria-label="Repository path"]', f.repo)
  await ui.named("Open")
  await ui.startManualReview()
  await openSettings()
  mark("initial Tokyo Night preference")
  await waitCodeTheme("Tokyo Night", "tokyo-night")
  mark("switch to ReviewBox")
  await ui.select('[aria-label="Code theme"]', "ReviewBox")
  await waitCodeTheme("ReviewBox", "reviewbox")
  mark("close and reopen settings")
  await ui.request(ui.route("/window"), undefined, "DELETE")
  await ui.request(ui.route("/window"), { handle: "main" })
  await openSettings()
  await waitCodeTheme("ReviewBox", "reviewbox")
  mark("restore Tokyo Night and verify bundled icons")
  await ui.select('[aria-label="Code theme"]', "Tokyo Night")
  await waitCodeTheme("Tokyo Night", "tokyo-night")
  assert(!(await ui.text()).includes("Import VS Code"))
  await ui.has("Included for everyone")
  await ui.screenshot("code-appearance-dark")
  mark("catalogue and installation")
  await ui.named("Languages", "nav button")
  await ui.until(
    `document.querySelectorAll('[data-server-id]').length === ${catalogue.length}`
  )
  await ui.fill('[aria-label="Search languages"]', "TypeScript")
  await ui.has("Recommended")
  assert(
    await ui.execute(`return !!document.querySelector('${row("typescript")}')`)
  )
  await ui.named("Install", `${row("typescript")} button`)
  await ui.wait(
    async () =>
      ui.execute(
        `return document.querySelector('${row("typescript")}')?.textContent.includes('Enabled')`
      ),
    "TypeScript installed and activated",
    300000
  )
  await ui.named("Disable", `${row("typescript")} button`)
  await ui.until(
    `document.querySelector('${row("typescript")}')?.textContent.includes('Disabled')`
  )
  await ui.named("Enable", `${row("typescript")} button`)
  await ui.until(
    `document.querySelector('${row("typescript")}')?.textContent.includes('Enabled')`
  )
  await ui.fill('[aria-label="Search languages"]', "Rust")
  await ui.named("Install", `${row("rust")} button`)
  await ui.named("Cancel", `${row("rust")} button`)
  await ui.until(
    `![...document.querySelectorAll('${row("rust")} button')].some(e=>e.textContent==='Cancel')`
  )
  mark("catalogue layout")
  await ui.fill('[aria-label="Search languages"]', "")
  for (const [theme, width] of [
    ["Dark", 1100],
    ["Light", 800],
  ] as const) {
    await ui.named("General", "nav button")
    await ui.named(theme, '[role="tab"]')
    await ui.named("Languages", "nav button")
    await ui.resize(width, 780)
    const layout = await ui.layout()
    assert.deepEqual(layout.overflow, [], `${theme} catalogue overflow`)
    assert.deepEqual(layout.clipped, [], `${theme} catalogue clipping`)
    await ui.screenshot(`languages-${theme.toLowerCase()}`)
  }
  await ui.named("Installed", '[role="tab"]')
  await ui.until("document.querySelectorAll('[data-server-id]').length === 1")
  await ui.named("Remove", `${row("typescript")} button`)
  await ui.has("No languages match this filter.")
  assert.equal(
    f.git("write-tree"),
    f.index,
    "Language installation leaves the Git index intact"
  )
  assert.deepEqual(await ui.execute("return window.__uiErrors ?? []"), [])
  console.log(
    "Native appearance persistence, bundled icons, language catalogue, real TypeScript installation, enable/disable/remove, cancellation and narrow/light/dark layouts passed."
  )
} catch (error) {
  console.error("Fixture root:", f.root)
  try {
    console.error("Persisted appearance:", appearance())
  } catch (probeError) {
    console.error(String(probeError))
  }
  console.error(
    "Visible code controls:",
    await ui
      .execute(
        `return [...document.querySelectorAll('[role=tab]')].map(e=>({text:e.textContent,selected:e.getAttribute('aria-selected'),disabled:e.disabled,rect:e.getBoundingClientRect().toJSON()}))`
      )
      .catch(() => [])
  )
  console.error(
    `Language settings failed during ${phase}`,
    await ui.text().catch(() => "")
  )
  await ui.screenshot("languages-failure").catch(() => {})
  throw error
} finally {
  if (originalTheme) {
    await ui
      .request(ui.route("/window"), { handle: "settings" })
      .then(async () => {
        await ui.named("General", "nav button")
        await ui.named(originalTheme!, '[role="tab"]')
      })
      .catch(() => {})
  }
  await ui.stop()
  if (!process.env.REVIEWBOX_KEEP_FIXTURE) await f.cleanup()
}
