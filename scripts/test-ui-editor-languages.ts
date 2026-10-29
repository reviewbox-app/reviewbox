import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { NativeUI, fixture } from "../tests/native/ui-driver"
import {
  editorLanguageFixture,
  plannerFixture,
} from "../tests/native/editor-language-fixture"
process.env.REVIEWBOX_NATIVE_ARTIFACTS ??=
  "artifacts/validation/editor-languages"
const f = await fixture(),
  ui = new NativeUI(),
  server = await editorLanguageFixture(f.root),
  planner = await plannerFixture(f.root)
let phase = "import pack"
type ServerCall = {
  pid: number
  method: string
  text?: string
  params?: { textDocument?: { uri?: string; text?: string } }
}
const serverCalls = async (): Promise<ServerCall[]> =>
  (await readFile(server.calls, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
const disk = () => readFile(join(f.repo, "main.exdsl"), "utf8")
const replace = async (text: string) => {
  await ui.until(
    "!document.querySelector('[role=dialog][data-open]')",
    "dialog closed"
  )
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
const switchMain = async () => {
  await ui.request(ui.route("/window"), undefined, "DELETE")
  await ui.request(ui.route("/window"), { handle: "main" })
}
const settings = async () => {
  await ui.named("Settings")
  await ui.wait(
    async () =>
      (await ui.request<string[]>(ui.route("/window/handles"))).includes(
        "settings"
      ),
    "settings window"
  )
  await ui.request(ui.route("/window"), { handle: "settings" })
  await ui.execute(
    `window.BASE_UI_ANIMATIONS_DISABLED=true;const frame=window.requestAnimationFrame.bind(window),cancel=window.cancelAnimationFrame.bind(window);window.requestAnimationFrame=cb=>document.hidden?-setTimeout(()=>cb(performance.now()),16):frame(cb);window.cancelAnimationFrame=id=>id<0?clearTimeout(-id):cancel(id);return true`
  )
}
try {
  await f.write("main.exdsl", "hello disk\n")
  await f.write("sibling.exdsl", "hello other\n")
  await f.write("example.config.json", '{"version":1}\n')
  await ui.start(join(f.root, "appdata"))
  await ui.named("or enter a path")
  await ui.fill('[aria-label="Repository path"]', f.repo)
  await ui.named("Open")
  await ui.named("Code Editor", "[role=tab]")
  await settings()
  await ui.named("Languages", "nav button")
  await ui.named("Import pack")
  await ui.fill(
    '[aria-label="Language pack JSON"]',
    JSON.stringify(server.manifest)
  )
  await ui.named("Import pack", "[data-slot=dialog-footer] button")
  await ui.has("Example DSL · 1.0.0")
  await ui.named("Rev", "nav button")
  await ui.setHarnessExecutable("codex", planner.executable)
  await switchMain()
  await ui.click('nav[aria-label="Project files"] [title="main.exdsl"]')
  await ui.named("Enable language support")
  await ui.has("Language support active")
  await ui.named("Stop", 'section[aria-label="Project file"] button')
  await ui.has("Language support stopped")
  await ui.named("Restart", 'section[aria-label="Project file"] button')
  await ui.has("Language support active")
  await ui.until(
    `(()=>{const spans=[...document.querySelectorAll('section[aria-label="Project file"] .view-line span')];const keyword=spans.find(e=>e.textContent==='hello'),plain=spans.find(e=>e.textContent?.includes('disk'));return keyword && plain && getComputedStyle(keyword).color!==getComputedStyle(plain).color})()`,
    "imported TextMate keyword coloring"
  )
  phase = "unsaved completion"
  await replace("hello draft\n")
  await ui.wait(
    async () => (await readFile(server.calls, "utf8")).includes("hello draft"),
    "unsaved LSP text"
  )
  await ui.execute(
    `document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:' ',code:'Space',keyCode:32,ctrlKey:true,bubbles:true,cancelable:true}));return true`
  )
  await ui.has("unsavedMember")
  await ui.keys("\uE00C")
  assert.equal(
    await readFile(join(f.repo, "main.exdsl"), "utf8"),
    "hello disk\n"
  )
  phase = "configuration refresh preserves the live draft"
  const initializations = (await serverCalls()).filter(
    (call) => call.method === "initialize"
  ).length
  await f.write("unrelated.txt", "unrelated to the language server\n")
  await Bun.sleep(1800)
  assert.equal(
    (await serverCalls()).filter((call) => call.method === "initialize").length,
    initializations,
    "unrelated file does not restart the server"
  )
  await f.write("example.config.json", '{"version":2}\n')
  await ui.wait(
    async () =>
      (await serverCalls()).filter((call) => call.method === "initialize")
        .length > initializations,
    "language session restarted for relevant configuration"
  )
  await ui.wait(async () => {
    const calls = await serverCalls()
    const pid = calls.filter((call) => call.method === "initialize").at(-1)?.pid
    return calls.some(
      (call) =>
        call.pid === pid &&
        call.method === "textDocument/didOpen" &&
        call.params?.textDocument?.text === "hello draft\n"
    )
  }, "unsaved text restored into reconfigured session")
  await ui.has("Language support active")
  assert.equal(await disk(), "hello disk\n")
  phase = "live definition navigation"
  await ui.click('section[aria-label="Project file"] .view-line span')
  await ui.execute(
    `document.querySelector('section[aria-label="Project file"] textarea').focus();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'F12',code:'F12',keyCode:123,bubbles:true,cancelable:true}));return true`
  )
  await ui.element('[role=tab][title="sibling.exdsl"][aria-selected=true]')
  await ui.click('[role=tab][title="main.exdsl"]')
  await ui.until(
    `document.querySelector('section[aria-label="Project file"] .view-lines')?.textContent.includes('draft')`
  )
  phase = "manual save imports before formatting"
  const beforeManual = (await serverCalls()).length
  await replace("hello savePipeline\n")
  await ui.shortcut("s")
  await ui.wait(
    async () => (await disk()) === "hello formattedAfterImports\n",
    "manual save transforms in order"
  )
  const manualCalls = (await serverCalls()).slice(beforeManual)
  const importsIndex = manualCalls.findIndex(
    (call) => call.method === "textDocument/codeAction"
  )
  const formatIndex = manualCalls.findIndex(
    (call) => call.method === "textDocument/formatting"
  )
  assert(
    importsIndex >= 0 && formatIndex > importsIndex,
    "imports precede formatting"
  )
  assert.equal(
    manualCalls[formatIndex].text,
    "hello importsApplied\n",
    "formatting sees synchronized import edits"
  )
  phase = "per-language save preferences"
  await ui.named("Project settings")
  await ui.click("#editor-format-save")
  await ui.named("Close", "[role=dialog] button")
  await replace("hello savePipeline formatOff\n")
  await ui.shortcut("s")
  await ui.wait(
    async () => (await disk()) === "hello importsApplied formatOff\n",
    "disabled formatter leaves organized text"
  )
  await ui.named("Project settings")
  await ui.click("#editor-format-save")
  await ui.named("Close", "[role=dialog] button")
  phase = "auto-save does not transform text"
  await ui.nativeMenu("Editor", "Auto save")
  const beforeAutomatic = (await serverCalls()).length
  await replace("hello savePipeline automatic\n")
  await ui.wait(
    async () => (await disk()) === "hello savePipeline automatic\n",
    "auto-save writes verbatim"
  )
  assert.equal(
    (await serverCalls())
      .slice(beforeAutomatic)
      .some((call) =>
        ["textDocument/codeAction", "textDocument/formatting"].includes(
          call.method
        )
      ),
    false,
    "auto-save performs no transformations"
  )
  await ui.nativeMenu("Editor", "Auto save")
  phase = "multifile rename"
  await ui.execute(
    `document.querySelector('section[aria-label="Project file"] textarea').focus();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'F2',code:'F2',keyCode:113,bubbles:true,cancelable:true}));return true`
  )
  await ui.fill("input.rename-input", "world")
  await ui.keys("\uE007")
  await ui.has("Review code changes")
  await ui.has("sibling.exdsl")
  assert.equal(
    await readFile(join(f.repo, "sibling.exdsl"), "utf8"),
    "hello other\n"
  )
  await ui.named("Apply changes")
  await ui.nativeMenu("Editor", "Save all")
  await ui.wait(
    async () =>
      (await readFile(join(f.repo, "sibling.exdsl"), "utf8")).startsWith(
        "world"
      ),
    "multifile save"
  )
  phase = "Rev plan without mutation"
  await ui.named("Configure with Rev")
  await ui.has("Add a reviewed project configuration")
  await ui.has("Language server: Example DSL · 1.0.0")
  await assert.rejects(() => readFile(join(f.repo, "language-config.json")))
  await ui.named("Close", "[role=dialog] button")
  await assert.rejects(() => readFile(join(f.repo, "language-config.json")))
  await ui.named("Configure with Rev")
  await ui.has("Apply plan")
  await ui.named("Apply plan")
  await ui.has("Language support verified.")
  assert.equal(
    await readFile(join(f.repo, "language-config.json"), "utf8"),
    '{"configured":true}\n'
  )
  const calls = (await readFile(planner.calls, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  const start = calls.find((m) => m.method === "thread/start"),
    turn = calls.find((m) => m.method === "turn/start")
  assert.equal(start.params.sandbox, "read-only")
  assert.equal(
    start.params.config.mcp_servers?.writer?.enabled ??
      start.params.config['mcp_servers."writer".enabled'],
    false
  )
  assert.equal(turn.params.sandboxPolicy.type, "readOnly")
  await ui.screenshot("pack-live-edit-and-reviewed-plan")
  console.log(
    "Native language fixtures: import without rebuild, local grammar/server activation, unsaved completion, targeted configuration restart preserving drafts, imports-before-format manual save, per-language preferences, verbatim auto-save, multifile preview/native Save all, plan rejection and explicit application; readonly harness contract verified."
  )
} catch (error) {
  await Bun.write(
    join(ui.artifacts, "lsp-calls.jsonl"),
    Bun.file(server.calls)
  ).catch(() => {})
  await ui.screenshot("failed-" + phase.replaceAll(" ", "-")).catch(() => {})
  throw new Error(phase + ": " + error, { cause: error })
} finally {
  await ui.stop()
  await f.cleanup()
}
