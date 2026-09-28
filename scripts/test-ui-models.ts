import assert from "node:assert/strict"
import { chmod, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { NativeUI, fixture } from "../tests/native/ui-driver"

const f = await fixture()
const ui = new NativeUI()
const mode = join(f.root, "catalog-mode")
const audit = join(f.root, "catalog-audit")
await writeFile(mode, "normal")
await writeFile(audit, "")
for (const provider of ["codex", "claude"]) {
  const executable = join(f.root, provider)
  await writeFile(
    executable,
    `#!${process.execPath}
import {readFileSync,appendFileSync} from "node:fs";
import {createInterface} from "node:readline";
const provider=${JSON.stringify(provider)}, args=process.argv.slice(2);
if(args[0]==='--version') { console.log(provider==='codex'?'codex-cli 0.157.0':'2.1.282 (Claude Code)'); process.exit(0); }
if(args[0]==='login'||args[0]==='auth') { console.log(provider==='codex'?'Logged in using ChatGPT':JSON.stringify({loggedIn:true})); process.exit(0); }
const mode=readFileSync(${JSON.stringify(mode)},'utf8');
appendFileSync(${JSON.stringify(audit)},JSON.stringify({provider,args,mode,pid:process.pid})+'\\n');
if(mode==='slow') { while(true) await Bun.sleep(1000); }
for await(const line of createInterface({input:process.stdin})) {
 const m=JSON.parse(line); let result;
 if(provider==='codex') {
  if(!['initialize','initialized','model/list'].includes(m.method)) throw Error('Discovery started a turn');
  if(m.method==='initialized') continue;
  if(m.method==='initialize') result={};
  else {
   if(mode==='error') {console.log(JSON.stringify({id:m.id,error:{message:'failure'}}));continue;}
   const second=!!m.params.cursor;
   result={data: mode==='empty'?[]:second?[{model:'gpt-6-luna',displayName:'GPT-6 Luna',description:'Fast model for small tasks',supportedReasoningEfforts:[{reasoningEffort:'medium'}]}]:[{model:'gpt-6-sol',displayName:'GPT-6 Sol',description:'Everyday coding work',supportedReasoningEfforts:[{reasoningEffort:'medium'}]}],nextCursor:second||mode==='empty'?null:'next'};
  }
  console.log(JSON.stringify({id:m.id,result}));
 } else {
  if(m.type!=='control_request'||m.request.subtype!=='initialize') throw Error('Discovery started a turn');
  console.log(JSON.stringify({type:'control_response',response:{request_id:m.request_id,subtype:mode==='error'?'error':'success',response:{models:mode==='empty'?[]:[{value:'sonnet',resolvedModel:'claude-sonnet-5',displayName:'Sonnet',description:'Sonnet 5 · Efficient for routine tasks',supportsEffort:true,supportedEffortLevels:['medium']},{value:'haiku',displayName:'Haiku',description:'Quick answers'}]}}}));
 }
}
`
  )
  await chmod(executable, 0o700)
}
const openPicker = async (selector: string) => {
  await ui.click(selector)
  await ui.until("!document.body.innerText.includes('Loading models…')")
}
const choose = (name: string) => ui.named(name, '[role="option"]', false)
// Discovery removes/disables its initiating button. The native driver's extra
// post-click focus would override the component's handoff to the search input.
const reloadModels = () =>
  ui.execute(
    "document.querySelector('[aria-label=\"Reload models\"]').click(); return true"
  )
const savedProject = async () =>
  JSON.parse(await readFile(join(f.repo, ".reviewbox/settings.json"), "utf8"))
    .data

let phase = "setup"
try {
  await ui.start(join(f.root, "appdata"))
  await ui.named("or enter a path")
  await ui.fill('[aria-label="Repository path"]', f.repo)
  await ui.named("Open")
  await ui.reviewScope()
  await ui.keys("\uE00C")
  await ui.named("Settings")
  await ui.wait(
    async () =>
      (await ui.request<string[]>(ui.route("/window/handles"))).includes(
        "settings"
      ),
    "settings window"
  )
  await ui.request(ui.route("/window"), { handle: "settings" })
  await ui.wait(
    async () => {
      try {
        return await ui.execute(
          "return document.readyState === 'complete' && !!document.querySelector('nav button')"
        )
      } catch (error) {
        // The new WebView's initial navigation can replace its script bridge.
        if (error instanceof DOMException && error.name === "TimeoutError")
          return false
        throw error
      }
    },
    "settings document",
    45000
  )
  // Covered macOS WebViews suspend animation frames. This suite verifies
  // selection and persistence, so use Base UI's animation-free test mode.
  await ui.execute(
    "window.BASE_UI_ANIMATIONS_DISABLED=true;window.__uiErrors=[];addEventListener('error',e=>window.__uiErrors.push(e.message));addEventListener('unhandledrejection',e=>window.__uiErrors.push(String(e.reason)));return true"
  )
  await ui.execute(`
    const frame = window.requestAnimationFrame.bind(window), cancel = window.cancelAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => document.hidden ? -setTimeout(() => callback(performance.now()), 16) : frame(callback);
    window.cancelAnimationFrame = id => id < 0 ? clearTimeout(-id) : cancel(id);
    return true;
  `)
  await ui.named("Rev", "nav button")
  await ui.setHarnessExecutable("codex", join(f.root, "codex"))
  await ui.setHarnessExecutable("claude", join(f.root, "claude"))
  phase = "helper selection"
  await openPicker("#helper-model")
  // The native click driver refocuses an option after selection; use the same
  // keyboard path as the primary model picker for this immediate-save field.
  await ui.fill('[aria-label="Search models"]', "GPT-6 Sol")
  await ui.keys("\uE015", "\uE007")
  await ui.until(
    "!document.querySelector('[role=listbox]')",
    "helper picker closes after saving"
  )
  await ui.until(
    "!!document.querySelector('#helper-model')?.textContent.match(/gpt[- ]6[- ]sol/i)"
  )
  await ui.until(
    "!document.querySelector('#helper-model')?.disabled",
    "helper preference saved"
  )
  await ui.harnessOption("codex", "Details")
  phase = "main catalog"
  await openPicker("#model-codex")
  await ui.has("GPT-6 Luna")
  await ui.has("Everyday coding work")
  await ui.fill('[aria-label="Search models"]', "small tasks")
  await ui.until("document.querySelectorAll('[role=option]').length === 1")
  await ui.keys("\uE015", "\uE007")
  await ui.until("!document.querySelector('[role=listbox]')")
  await ui.until(
    "document.querySelector('#model-codex')?.textContent.includes('GPT-6 Luna')"
  )
  assert(
    (await ui.text()).includes("Codex details"),
    "selection does not submit the settings form"
  )
  await ui.named("Save", "form button")
  phase = "main remount"
  await ui.until("!document.querySelector('#model-codex')")
  await ui.harnessOption("codex", "Details")
  assert(
    (await ui.text()).includes("gpt-6-luna"),
    "selected model survives remount"
  )
  assert(
    await ui.execute(
      "return !!document.querySelector('#helper-model')?.textContent.match(/gpt[- ]6[- ]sol/i)"
    ),
    "main model selection preserves the independent helper preference"
  )
  await openPicker("#model-codex")
  const before = (await readFile(audit, "utf8")).trim().split("\n").length
  await ui.keys("\uE00C")
  await openPicker("#model-codex")
  assert.equal(
    (await readFile(audit, "utf8")).trim().split("\n").length,
    before,
    "catalog reused during editing"
  )
  await writeFile(mode, "error")
  phase = "catalog reload error"
  await reloadModels()
  await ui.has("invalid model catalog")
  assert((await ui.text()).includes("gpt-6-luna"), "error keeps the selection")
  await writeFile(mode, "normal")
  phase = "catalog retry"
  await ui.execute(
    "[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Try again').click(); return true"
  )
  await ui.has("GPT-6 Luna")
  await writeFile(mode, "empty")
  phase = "empty catalog"
  await reloadModels()
  await ui.has("No models returned by this harness.")
  await ui.has("Not listed by this harness")
  await choose("Harness default")
  await ui.named("Save", "form button")
  await ui.until("!document.querySelector('#model-codex')")
  await ui.harnessOption("codex", "Details")
  await ui.has("Harness default")
  await ui.named("Cancel", "form button")
  await writeFile(mode, "normal")
  await ui.harnessOption("claude", "Details")
  await openPicker("#model-claude")
  await ui.has("Sonnet 5 · Efficient for routine tasks")
  await choose("Haiku")
  await ui.named("Save", "form button")
  await ui.until("!document.querySelector('#model-claude')")
  await ui.named("Project", "nav button")
  phase = "project selection"
  await openPicker("#project-model")
  await ui.fill('[aria-label="Search models"]', "no-such-model")
  await ui.has("No matching models.")
  await ui.keys("\uE00C")
  await ui.element("#project-model")
  await openPicker("#project-model")
  await choose("GPT-6 Sol")
  await ui.named("Save project settings")
  await ui.has("Saved in .reviewbox")
  assert.equal((await savedProject()).provider, "codex")
  assert.equal((await savedProject()).model, "gpt-6-sol")
  assert(
    !("helperModel" in (await savedProject())),
    "helper preference stays private"
  )
  await ui.select("#project-provider", "claude")
  phase = "Claude project selection"
  await ui.until(
    "document.querySelector('#project-model')?.textContent.includes('Use application settings')"
  )
  await openPicker("#project-model")
  await choose("Sonnet")
  await ui.named("Save project settings")
  await ui.has("Saved in .reviewbox")
  assert.equal((await savedProject()).provider, "claude")
  assert.equal((await savedProject()).model, "sonnet")

  // Changing harnesses while discovery is pending must ignore its old response.
  phase = "cancel catalog and switch harness"
  await writeFile(mode, "slow")
  await openPicker("#project-model")
  // The native driver's element/click focuses its target after running onClick,
  // overriding application focus changes. Use the same DOM click without that
  // extra focus to verify the product's actual focus handoff and cancellation.
  await ui.execute(
    `document.querySelector('[aria-label="Reload models"]').click(); return true`
  )
  await ui.has("Loading models…")
  assert.equal(
    await ui.execute(
      "return document.activeElement?.getAttribute('aria-label')"
    ),
    "Search models"
  )
  await ui.keys("\uE00C")
  await ui.select("#project-provider", "codex")
  await writeFile(mode, "normal")
  await openPicker("#project-model")
  await ui.has("GPT-6 Sol")
  assert(!(await ui.text()).includes("Sonnet 5 · Efficient"))
  await ui.keys("\uE00C")
  await ui.named("Save project settings")
  await ui.has("Saved in .reviewbox")
  assert.equal((await savedProject()).model, null)
  for (const theme of ["Dark", "Light"]) {
    await ui.named("General", "nav button")
    await ui.named(theme, '[role="tab"]')
    await ui.named("Rev", "nav button")
    await ui.harnessOption("claude", "Details")
    await ui.resize(800, 600)
    await openPicker("#model-claude")
    await ui.has("Sonnet 5 · Efficient")
    assert.deepEqual((await ui.layout()).overflow, [])
    await ui.screenshot(`model-selector-${theme.toLowerCase()}`)
    await ui.keys("\uE00C")
    await ui.named("Cancel", "form button")
  }
  const errors = await ui.execute<string[]>("return window.__uiErrors")
  const layoutNotice =
    "ResizeObserver loop completed with undelivered notifications."
  // WebKit can defer one resize notification when the occluded test window is
  // resized with an open popup. Overflow is checked above; keep real errors fatal.
  assert.deepEqual(
    errors.filter((error) => error !== layoutNotice),
    []
  )
  if (errors.length)
    console.log(
      `WebKit deferred layout notifications during resizing: ${errors.length}`
    )
  const operations = (await readFile(audit, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  for (const operation of operations.filter(
    (item) => item.provider === "claude"
  )) {
    assert(operation.args.includes("--no-session-persistence"))
    assert(operation.args.includes("--safe-mode"))
  }
  console.log(
    "Native model selectors: catalogs, search/keyboard, defaults, save/remount, cache/reload, errors/retry, unlisted values, project harness binding, inheritance, cancellation/stale results and 800px dark/light passed"
  )
} catch (error) {
  console.error("Model test phase:", phase)
  await ui.screenshot("models-failure").catch(() => {})
  console.error(await ui.text().catch(() => "No UI"))
  throw error
} finally {
  await ui.stop()
  await f.cleanup()
}
