import assert from "node:assert/strict"
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises"
import { dirname, join } from "node:path"
import { NativeUI, fixture } from "../tests/native/ui-driver"

// Real Tauri IPC and subprocesses, with isolated CLI/installers: no account,
// network installation, or modification of the user's existing harnesses.
const f = await fixture()
const ui = new NativeUI()
const prefix = join(f.root, "fixture's node installation")
const modeFile = join(f.root, "installer-mode")
const auditFile = join(f.root, "installer-audit")
const versions = join(f.root, "versions.json")
await writeFile(modeFile, "success")
await writeFile(auditFile, "")
await writeFile(
  versions,
  JSON.stringify({ codex: "0.147.0", claude: "2.1.281" })
)
const paths = {
  codex: join(prefix, "bin/codex"),
  claude: join(prefix, "bin/claude"),
}
for (const provider of ["codex", "claude"] as const) {
  const binary = join(
    prefix,
    provider === "codex"
      ? "lib/node_modules/@openai/codex/bin/codex.js"
      : "lib/node_modules/@anthropic-ai/claude-code/cli.js"
  )
  await mkdir(dirname(binary), { recursive: true })
  await mkdir(dirname(paths[provider]), { recursive: true })
  await writeFile(
    binary,
    `#!${process.execPath}
import {readFileSync} from "node:fs";
import {createInterface} from "node:readline";
const provider=${JSON.stringify(provider)}, args=process.argv.slice(2);
if(args[0]==="--version") {
 const version=JSON.parse(readFileSync(${JSON.stringify(versions)},"utf8"))[provider];
 console.log(provider==="codex"?"codex-cli "+version:version+" (Claude Code)");
} else if(args[0]==="login" || args[0]==="auth") {
 console.log(provider==="codex"?"Logged in using ChatGPT":JSON.stringify({loggedIn:true}));
} else if (args[0]==="app-server") {
 for await (const line of createInterface({input:process.stdin})) {
  const message=JSON.parse(line);
  if(message.method==="initialize") console.log(JSON.stringify({id:message.id,result:{}}));
  else if(message.method==="model/list") console.log(JSON.stringify({id:message.id,result:{data:[{model:"fixture-model",displayName:"Fixture model",description:"Test catalog model"}],nextCursor:null}}));
 }
} else process.exit(1);
`
  )
  await chmod(binary, 0o700)
  await symlink(binary, paths[provider])
}
const npm = join(prefix, "bin/npm")
await writeFile(
  npm,
  `#!${process.execPath}
import {readFileSync,appendFileSync,writeFileSync} from "node:fs";
const args=process.argv.slice(2),mode=readFileSync(${JSON.stringify(modeFile)},"utf8");
appendFileSync(${JSON.stringify(auditFile)},JSON.stringify({args,mode})+"\\n");
if(args[0]==="view") {
 if(mode==="check-failure") process.exit(1);
 console.log(JSON.stringify([args[1]==="@openai/codex@latest"?"0.157.0":"2.1.282"]));
 process.exit(0);
}
if(mode==="failure") process.exit(1);
await Bun.sleep(mode==="slow"?60000:1000);
const versions=JSON.parse(readFileSync(${JSON.stringify(versions)},"utf8"));
if(args.at(-1)==="@openai/codex@latest") versions.codex="0.157.0";
else if(args.at(-1)==="@anthropic-ai/claude-code@latest") versions.claude="2.1.282";
else process.exit(2);
writeFileSync(${JSON.stringify(versions)},JSON.stringify(versions));
`
)
await chmod(npm, 0o700)
const menuItems = (name: string) =>
  ui.execute<string[]>(
    `const trigger=document.querySelector('[aria-label="'+arguments[0]+' options"]');
   return [...document.getElementById(trigger.getAttribute('aria-controls')).querySelectorAll('[role=menuitem]')].map(el=>el.textContent.trim())`,
    [name]
  )
const closeDialog = () => ui.named("Done")
const card = (provider: "codex" | "claude") =>
  `article[aria-label="${provider === "codex" ? "Codex" : "Claude Code"} harness"]`
try {
  await ui.start(join(f.root, "appdata"))
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
    "window.__uiErrors=[];addEventListener('error',e=>window.__uiErrors.push(e.message));addEventListener('unhandledrejection',e=>window.__uiErrors.push(String(e.reason)));return true"
  )
  await ui.execute(`window.BASE_UI_ANIMATIONS_DISABLED=true;
    const frame=window.requestAnimationFrame.bind(window),cancel=window.cancelAnimationFrame.bind(window);
    window.requestAnimationFrame=callback=>document.hidden?-setTimeout(()=>callback(performance.now()),16):frame(callback);
    window.cancelAnimationFrame=id=>id<0?clearTimeout(-id):cancel(id);return true`)
  await ui.named("Dark", '[role="tab"]')
  await ui.named("Rev", "nav button")
  await ui.setHarnessExecutable("codex", paths.codex)
  await ui.setHarnessExecutable("claude", paths.claude)
  await ui.has("Outdated")
  await ui.until(
    `document.querySelector('${card("codex")} [role=status]').classList.contains('text-review-attention')`,
    "orange outdated state"
  )
  assert.equal(
    await ui.execute("return !!document.querySelector('dl')"),
    false,
    "details hidden in compact overview"
  )
  await ui.resize(1040, 720)
  await ui.screenshot("harness-settings-compact-dark")
  await ui.named("Codex options")
  assert.deepEqual(await menuItems("Codex"), [
    "Details",
    "Check updates",
    "Redetect",
    "Choose another exec",
  ])
  await ui.screenshot("harness-settings-menu-dark")
  await ui.keys("\uE00C")
  await ui.until(
    "!document.querySelector('button[aria-label=\"Codex options\"][aria-expanded=true]')",
    "Escape closes menu without closing settings"
  )
  await ui.harnessOption("codex", "Details")
  await ui.has("0.157.0")
  await ui.has("Signed in through Codex")
  await ui.click("#model-codex")
  await ui.named("Fixture model", '[role="option"]', false)
  await ui.named("Save", "form button")
  await ui.until("!document.querySelector('#model-codex')")
  await ui.harnessOption("codex", "Details")
  assert.equal(
    await ui.execute(
      "return document.querySelector('#model-codex').textContent.trim()"
    ),
    "fixture-model"
  )
  await ui.named("Cancel")
  await ui.harnessOption("codex", "Choose another exec")
  await ui.fill('[aria-label="codex executable"]', "/not/saved")
  await ui.named("Cancel")
  await ui.harnessOption("codex", "Details")
  await ui.has(paths.codex)
  await ui.named("Cancel")
  await ui.setDefaultHarness("claude")
  await ui.until(
    `!!document.querySelector('${card("claude")} [data-slot=badge]')`,
    "default autosaved"
  )
  await ui.harnessOption("codex", "Check updates")
  await ui.has("Install the update?")
  assert(
    !(await readFile(auditFile, "utf8")).includes('"install"'),
    "checking never installs"
  )
  await ui.screenshot("harness-update-confirmation")
  await ui.named("Not now")
  assert(
    !(await readFile(auditFile, "utf8")).includes('"install"'),
    "declining never installs"
  )
  await ui.harnessOption("codex", "Check updates")
  await ui.named("Install update")
  await ui.has("Update complete. Harness detected.")
  await closeDialog()
  await ui.until(
    `document.querySelector('${card("codex")} [role=status]').textContent === 'Connected'`,
    "updated Codex re-detected"
  )
  await ui.harnessOption("codex", "Details")
  await ui.has("codex-cli 0.157.0")
  assert.equal(
    await ui.execute(
      "return document.querySelector('#model-codex').textContent.trim()"
    ),
    "fixture-model",
    "update preserves model"
  )
  await ui.named("Cancel")
  for (const name of ["Codex", "Claude Code"]) {
    await ui.named(`${name} options`)
    assert.deepEqual(
      await menuItems(name),
      ["Details", "Check updates", "Redetect", "Choose another exec"],
      "supported harness can still check for newer releases"
    )
    await ui.keys("\uE00C")
  }
  await ui.harnessOption("codex", "Check updates")
  await ui.has("Codex is up to date")
  assert(!(await ui.text()).includes("Install the update?"))
  await writeFile(modeFile, "check-failure")
  await ui.harnessOption("codex", "Check updates")
  await ui.has("Could not check for updates")
  assert(!(await ui.text()).includes("Codex is up to date"))
  await writeFile(modeFile, "success")
  await ui.harnessOption("claude", "Check updates")
  await ui.has("Claude Code 2.1.282 is available")
  await ui.named("Install update")
  await ui.has("Update complete. Harness detected.")
  await closeDialog()
  await ui.harnessOption("claude", "Check updates")
  await ui.has("Claude Code is up to date")
  // Failure is surfaced, and Retry uses the same installation.
  await writeFile(
    versions,
    JSON.stringify({ codex: "0.147.0", claude: "2.1.281" })
  )
  await ui.harnessOption("codex", "Redetect")
  await ui.has("Outdated")
  await writeFile(modeFile, "failure")
  await ui.harnessOption("codex", "Check updates")
  await ui.named("Install update")
  await ui.has("The installer failed")
  await writeFile(modeFile, "success")
  await ui.named("Retry update")
  await ui.has("Update complete. Harness detected.")
  await closeDialog()
  await ui.harnessOption("codex", "Details")
  await ui.has("codex-cli 0.157.0")
  await ui.named("Cancel")
  // Cancel terminates the real controlled process without publishing success.
  await writeFile(
    versions,
    JSON.stringify({ codex: "0.147.0", claude: "2.1.281" })
  )
  await ui.harnessOption("codex", "Redetect")
  await ui.has("Outdated")
  await writeFile(modeFile, "slow")
  await ui.harnessOption("codex", "Check updates")
  await ui.named("Install update")
  await ui.has("Updating this npm installation")
  await ui.named("Cancel update")
  await ui.has("Installation cancelled")
  assert.equal((await ui.text()).includes("Update complete."), false)
  await closeDialog()
  await writeFile(
    versions,
    JSON.stringify({ codex: "0.157.0", claude: "2.1.281" })
  )
  await ui.harnessOption("codex", "Redetect")
  await ui.until(
    `document.querySelector('${card("codex")} [role=status]').textContent === 'Connected'`
  )
  // Reopen the section to verify the saved configuration survived remounting.
  await ui.named("General", "nav button")
  await ui.named("Light", '[role="tab"]')
  await ui.named("Rev", "nav button")
  await ui.has("Connected")
  await ui.until(
    "document.querySelector('#default-provider')?.textContent.includes('Claude Code')"
  )
  for (const [width, height] of [
    [1040, 720],
    [800, 600],
  ]) {
    await ui.resize(width, height)
    const layout = await ui.layout()
    assert.deepEqual(
      layout.overflow,
      [],
      `settings must not scroll horizontally at ${width}`
    )
    assert.deepEqual(layout.clipped, [])
    await ui.screenshot(`harness-settings-light-${width}`)
  }
  const audit = (await readFile(auditFile, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.args[0] === "install")
  assert.equal(
    audit.length,
    5,
    "two updates, failure/retry/cancel, no installation from checking or declining"
  )
  for (const entry of audit)
    assert.deepEqual(entry.args.slice(0, 4), [
      "install",
      "--global",
      "--prefix",
      await realpath(prefix),
    ])
  assert.equal(audit[0].args.at(-1), "@openai/codex@latest")
  assert.equal(audit[1].args.at(-1), "@anthropic-ai/claude-code@latest")
  assert.deepEqual(await ui.execute("return window.__uiErrors"), [])
  console.log(
    "Native harness settings: compact cards, exact menu, orange Outdated, model/path persistence, cancelled edit, default autosave, read-only checks, confirmation/decline, up-to-date and network errors, failure/retry/cancel, redetection, dark/light and 800px layout passed"
  )
} catch (error) {
  await ui.screenshot("harness-settings-failure").catch(() => {})
  console.error(await ui.text().catch(() => ""))
  throw error
} finally {
  await ui.stop()
  await f.cleanup()
}
