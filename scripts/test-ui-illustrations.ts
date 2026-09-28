import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { NativeUI, fixture } from "../tests/native/ui-driver"
import { createPreparationHarness } from "../tests/native/preparation-fixture"

const f = await fixture()
const ui = new NativeUI()
let networkRequests = 0
const server = Bun.serve({
  port: 0,
  fetch() {
    networkRequests++
    return new Response("unexpected")
  },
})
const source = `<h3>Behavior simulation</h3><button id="increment" aria-label="Increment value">Increment</button><output id="value">0</output>
<script>
addEventListener('message',event=>{if(event.source===parent&&event.data?.type==='theme')parent.postMessage({channel:'theme-probe',dark:event.data.dark,background:getComputedStyle(document.body).backgroundColor},'*')});
addEventListener('DOMContentLoaded',async()=>{
 const result={parentBlocked:false,storageBlocked:false,ipcAbsent:!window.__TAURI_INTERNALS__,networkBlocked:false,fileBlocked:false,ipcBlocked:false,popupBlocked:false,count:0};
 try { void parent.document.body } catch { result.parentBlocked=true }
 try { localStorage.setItem('probe','1') } catch { result.storageBlocked=true }
 try { await fetch('http://127.0.0.1:${server.port}/probe') } catch { result.networkBlocked=true }
 try { await fetch('file:///etc/passwd') } catch { result.fileBlocked=true }
 try { await fetch('ipc://localhost/get_app_info',{method:'POST',body:'{}'}) } catch { result.ipcBlocked=true }
 result.popupBlocked=window.open('http://127.0.0.1:${server.port}/popup')===null;
 document.querySelector('#increment').onclick=()=>{result.count++;document.querySelector('#value').textContent=result.count};
 document.querySelector('#increment').click();document.querySelector('#increment').click();
 parent.postMessage({channel:'isolation-probe',...result},'*');
 window.reviewboxIllustration.openReference('missing');
 setTimeout(()=>{location.href='http://127.0.0.1:${server.port}/escape'},250);
 setTimeout(()=>window.reviewboxIllustration.openTerm('assignment'),500);
 setTimeout(()=>{throw new Error('Deliberate illustration failure')},800);
});
</script>`
const harness = await createPreparationHarness(f.root, false, 2, false, source)
await writeFile(harness.mode, "done")
try {
  await ui.start(join(f.root, "appdata"))
  await ui.execute(
    `window.BASE_UI_ANIMATIONS_DISABLED=true;window.__isolationReports=[];window.__illustrationThemes=[];window.addEventListener('message',event=>{if(event.data?.channel==='theme-probe')window.__illustrationThemes.push(event.data)});window.addEventListener('message',event=>{if(event.data?.channel==='isolation-probe')window.__isolationReports.push({...event.data,origin:event.origin})});return true`
  )
  await ui.named("Settings")
  await ui.wait(
    async () =>
      (await ui.request<string[]>(ui.route("/window/handles"))).includes(
        "settings"
      ),
    "settings"
  )
  await ui.request(ui.route("/window"), { handle: "settings" })
  await ui.named("Rev", "nav button")
  await ui.setHarnessExecutable("codex", harness.executable)
  await ui.setDefaultHarness("codex")
  await ui.request(ui.route("/window"), { handle: "main" })
  await ui.named("or enter a path")
  await ui.fill('[aria-label="Repository path"]', f.repo)
  await ui.named("Open")
  await ui.reviewScope()
  await ui.nextReviewStep()
  await ui.named("With Rev", "label", false)
  await ui.named("Start review", "[role=dialog] footer button")
  await ui.has("Your review is ready")
  await ui.named("Start review")
  await ui.until(
    "window.__isolationReports.length > 0",
    "isolated JavaScript execution"
  )
  const reports = await ui.execute<Record<string, unknown>[]>(
    "return window.__isolationReports"
  )
  for (const report of reports) {
    for (const key of [
      "parentBlocked",
      "storageBlocked",
      "ipcAbsent",
      "networkBlocked",
      "fileBlocked",
      "ipcBlocked",
      "popupBlocked",
    ])
      assert.equal(report[key], true, key)
    assert.equal(report.count, 2)
    assert.equal(report.origin, "null")
  }
  assert.equal(networkRequests, 0)
  await ui.until(
    '!!document.querySelector("[role=dialog]")',
    "glossary bridge after canonicalization"
  )
  await ui.has("Giving a value a name.")
  await ui.keys("\uE00C")
  await ui.has("This illustration could not render correctly.")
  assert.equal(
    networkRequests,
    0,
    "navigation and popups cannot reach the network"
  )
  const frame = await ui.execute<{
    src: string
    sandbox: string
    readable: boolean
  }>(
    `const f=document.querySelector('iframe');return {src:f.src,sandbox:f.getAttribute('sandbox'),readable:!!f.contentDocument}`
  )
  assert(frame.src.includes("reviewbox-illustration"))
  assert.equal(frame.sandbox, "allow-scripts")
  assert.equal(frame.readable, false)
  await ui.until(
    "window.__illustrationThemes.length > 0",
    "initial illustration theme"
  )
  const light = await ui.execute<string>(
    "return window.__illustrationThemes.at(-1).background"
  )
  await ui.request(ui.route("/window"), { handle: "settings" })
  await ui.named("General", "nav button")
  await ui.named("Dark", '[role="tab"]')
  await ui.request(ui.route("/window"), { handle: "main" })
  await ui.until(
    "window.__illustrationThemes.at(-1)?.dark === true",
    "illustration dark theme"
  )
  assert.notEqual(
    await ui.execute("return window.__illustrationThemes.at(-1).background"),
    light
  )
  assert.equal(
    await ui.execute("return document.querySelector('iframe').src"),
    frame.src,
    "theme updates preserve the simulation"
  )
  await ui.screenshot("isolated-illustration")
  await ui.named("Validate step and continue")
  await ui.until(
    `!!document.querySelector('iframe') && document.querySelector('iframe').src !== ${JSON.stringify(frame.src)}`,
    "leaving the step destroys its old frame"
  )
  assert.deepEqual(await ui.execute("return window.__uiErrors"), [])
  assert.equal(f.git("write-tree"), f.index)
  console.log(
    "Native illustration: JS interaction, opaque origin, glossary bridge, denied network/file/parent/storage/IPC access passed"
  )
} catch (error) {
  await ui.screenshot("illustration-failure").catch(() => {})
  console.error(await ui.text().catch(() => "No UI"))
  throw error
} finally {
  server.stop()
  await ui.stop()
  await f.cleanup()
}
