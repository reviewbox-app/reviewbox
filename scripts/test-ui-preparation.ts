import assert from "node:assert/strict"
import { chmod, readFile, realpath, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { NativeUI, fixture } from "../tests/native/ui-driver"

// A real subprocess with deterministic output; no paid provider calls and no
// installation. Product operations go through the native WebView controls.
const f = await fixture()
const ui = new NativeUI()
const executable = join(f.root, "claude-fixture")
const modeFile = join(f.root, "provider-mode")
const runsFile = join(f.root, "provider-runs")
const auditFile = join(f.root, "provider-audit")
await writeFile(modeFile, "topics")
await writeFile(runsFile, "")
await writeFile(
  executable,
  `#!${process.execPath}
import { readFile, appendFile } from "node:fs/promises";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.0 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const prompt = await Bun.stdin.text();
await appendFile(${JSON.stringify(runsFile)}, "run\\n");
const mode = (await readFile(${JSON.stringify(modeFile)}, "utf8")).trim();
if (mode === "slow") { while (true) await Bun.sleep(1000); }
if (mode === "error") { console.log(JSON.stringify({type:"result",is_error:true})); process.exit(0); }
const manifestLine = prompt.split("\\n").find(line => line.trim().startsWith('"reviewManifest":'));
const manifestPath = JSON.parse(manifestLine.slice(manifestLine.indexOf(":") + 1).trim().replace(/,$/, ""));
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const metadata = await Promise.all(manifest.changes.map(item => readFile(item.metadata, "utf8").then(JSON.parse)));
const anchors = metadata.filter(item => item.change.path === "src/answer.ts").flatMap(item => item.anchors);
const frozen = metadata.find(item => item.change.path === "src/answer.ts" && item.change.layer === "staged");
const captured = await readFile(frozen.after.path, "utf8");
const live = await readFile("src/answer.ts", "utf8");
await appendFile(${JSON.stringify(auditFile)}, JSON.stringify({cwd:process.cwd(),args,promptBytes:Buffer.byteLength(prompt),captured,live,manifestPath})+"\\n");
console.log(JSON.stringify({type:"stream_event",event:{type:"content_block_start",content_block:{type:"tool_use",name:"Read"}}}));
console.log(JSON.stringify({type:"stream_event",event:{delta:{type:"text_delta",text:"I explored the project before preparing the result."}}}));
console.log(JSON.stringify({type:"system",subtype:"compact_boundary"}));
if (!anchors.length) { console.log(JSON.stringify({type:"result",is_error:true})); process.exit(0); }
const topic = (id, title, anchor) => ({id,title,brief:"Check the captured behavior and risks.",steps:[{id:id+"-step",title:"Read the captured change",explanation:"Check this source passage.",anchors:[anchor]}]});
const content = { kind: "topics", topics: [
  topic("topic-valid", "Captured behavior", anchors[0]),
  topic("topic-repair", "Repair a suggested anchor", {...anchors[0],passageId:"invented"}),
  topic("topic-reject", "Unwanted suggestion", anchors[0]),
] };
console.log(JSON.stringify({type:"result",is_error:false,result:JSON.stringify(content)}));
`
)
await chmod(executable, 0o700)
await f.write(".env.local", "TOKEN=fixture-only\n")
await writeFile(join(f.repo, "binary.bin"), Buffer.from([0, 1, 2]))
f.git("add", ".env.local", "binary.bin")
const index = f.git("write-tree")

async function settings() {
  await ui.named("Settings")
  await ui.wait(
    async () =>
      (await ui.request<string[]>(ui.route("/window/handles"))).includes(
        "settings"
      ),
    "settings window"
  )
  await ui.request(ui.route("/window"), { handle: "settings" })
}
async function main() {
  await ui.request(ui.route("/window"), { handle: "main" })
}
async function startReview() {
  await ui.until(
    '[...document.querySelectorAll("button")].some((button) => button.textContent.trim() === "Next" && !button.disabled)'
  )
  await ui.named("Next")
  await ui.has("How should we prepare the reading?")
  await ui.named("With Rev", "label", false)
  await ui.named("Start review")
  await ui.until('!!document.querySelector("[data-testid=preparing-review]")')
}
async function newReview() {
  await ui.keys("\uE03D", "n")
  await startReview()
}
const topic = (id: string) => `article[data-topic-id="${id}"]`

try {
  await ui.start(`${f.root}/appdata`)
  await settings()
  await ui.named("Rev", "nav button")
  await ui.setHarnessExecutable("claude", executable)
  await ui.setHarnessExecutable("codex", join(f.root, "missing-codex"))
  await ui.setDefaultHarness("claude")
  await ui.has("Connected")
  await main()
  await ui.named("or enter a path")
  await ui.fill('[aria-label="Repository path"]', f.repo)
  await ui.named("Open")
  await startReview()
  await ui.until(`!!document.querySelector('${topic("topic-repair")}')`)
  assert.equal(
    (await readFile(runsFile, "utf8")).trim().split("\n").length,
    1,
    "automatic preparation runs once"
  )
  await ui.has("Autonomous exploration")
  assert(!(await ui.text()).includes("Choose files"))
  const audit = JSON.parse(
    (await readFile(auditFile, "utf8")).trim().split("\n")[0]
  )
  assert.equal(await realpath(audit.cwd), await realpath(f.repo))
  assert(audit.args.includes("bypassPermissions"))
  assert(audit.args.includes("--no-session-persistence"))
  assert(!audit.args.includes("--tools"))
  assert(
    audit.promptBytes < 16000,
    "only compact instructions enter the prompt"
  )
  assert(audit.captured.includes("42"), "staged version is read on demand")
  assert(
    audit.live.includes("43"),
    "harness explores the actual working directory"
  )
  await ui.named("Accept", `${topic("topic-valid")} button`)
  await ui.named("Undo", `${topic("topic-valid")} button`)
  await ui.named("Accept", `${topic("topic-valid")} button`)
  await ui.named("Reject remaining")
  await ui.named("Undo", `${topic("topic-repair")} button`)
  assert(
    await ui.execute(
      `return [...document.querySelectorAll('${topic("topic-repair")} button')].find(button => button.textContent.trim() === "Accept").disabled`
    ),
    "invalid anchor blocks acceptance"
  )
  await ui.named("Fix anchor", `${topic("topic-repair")} button`)
  await ui.click('[aria-label="Passage for step 1, anchor 1"]')
  await ui.until('!!document.querySelector("[role=option]")')
  const option = await ui.execute<string>(
    'return document.querySelector("[role=option]").textContent.trim()'
  )
  await ui.named(option, '[role="option"]')
  await ui.named("Save changes", '[role="dialog"] button')
  await ui.named("Accept", `${topic("topic-repair")} button`)
  await ui.has("Add 2 accepted topics")
  await ui.has("All retained anchors match the review files.")
  for (const theme of ["Dark", "Light"]) {
    await ui.request(ui.route("/window"), { handle: "settings" })
    await ui.named("General", "nav button")
    await ui.named(theme, '[role="tab"]')
    await main()
    await ui.until(
      `document.documentElement.classList.contains(${JSON.stringify(theme.toLowerCase())})`
    )
    for (const [width, height] of [
      [1440, 900],
      [800, 600],
    ]) {
      await ui.resize(width, height)
      const layout = await ui.layout()
      assert.deepEqual(
        layout.overflow,
        [],
        `preparation has no horizontal scroll at ${width}`
      )
      assert.deepEqual(
        layout.clipped,
        [],
        `preparation controls fit at ${width}`
      )
      const geometry = await ui.execute<{
        headerHeight: number
        manualVisible: boolean
      }>(
        `const header=document.querySelector('main[aria-label="Suggested topics"] > header').getBoundingClientRect(); const button=[...document.querySelectorAll('aside button')].find(item=>item.textContent.trim()==='Continue manually').getBoundingClientRect(); return {headerHeight:header.height,manualVisible:button.top>=0 && button.bottom<=innerHeight};`
      )
      assert(
        geometry.manualVisible,
        "manual continuation stays pinned and visible with expanded context"
      )
      if (width === 800)
        assert(
          geometry.headerHeight <= 160,
          "narrow header stacks its actions without squeezing the title"
        )
      await ui.screenshot(`preparation-${theme.toLowerCase()}-${width}`)
    }
  }
  await ui.named("Add 2 accepted topics")
  await ui.until('!document.querySelector("[data-testid=preparing-review]")')
  await ui.has("Captured behavior")
  await ui.has("Repair a suggested anchor")
  assert(
    !(await ui.text()).includes("Unwanted suggestion"),
    "rejected topic is not added"
  )
  await ui.resize(1440, 900)

  await writeFile(modeFile, "slow")
  await newReview()
  await ui.has("Waiting for Claude Code…")
  await ui.named(
    "Cancel",
    '[aria-label="Rev preparation session"] button',
    false
  )
  await ui.has("Preparation stopped. Your frozen review has been kept.")
  await ui.named("Continue manually")
  await ui.until('!document.querySelector("[data-testid=preparing-review]")')

  await writeFile(modeFile, "error")
  await newReview()
  await ui.has("Your frozen review is available.")
  await writeFile(modeFile, "topics")
  await ui.named("Try again")
  await ui.has("Captured behavior")
  await ui.named("Continue manually")
  assert.equal(f.git("write-tree"), index, "Git index stays unchanged")

  // Exceed the old aggregate and per-file budgets. The provider must start
  // automatically with compact instructions, without any file-selection UI.
  for (const name of ["a", "b", "c"])
    await f.write(`src/context-${name}.ts`, `//${"x".repeat(220 * 1024)}\n`)
  f.git("add", "src/context-a.ts", "src/context-b.ts", "src/context-c.ts")
  const largeIndex = f.git("write-tree")
  const runsBefore = (await readFile(runsFile, "utf8"))
    .trim()
    .split("\n").length
  await newReview()
  await ui.has("Captured behavior")
  assert.equal(
    (await readFile(runsFile, "utf8")).trim().split("\n").length,
    runsBefore + 1
  )
  const largeAudit = JSON.parse(
    (await readFile(auditFile, "utf8")).trim().split("\n").at(-1)!
  )
  assert(largeAudit.promptBytes < 16000)
  assert(!(await ui.text()).includes("Choose fewer files"))
  assert(!(await ui.text()).includes("512 KiB"))
  await ui.named("Continue manually")
  assert.equal(
    f.git("write-tree"),
    largeIndex,
    "exploration leaves Git untouched"
  )
  assert.deepEqual(await ui.execute("return window.__uiErrors"), [])
  console.log(
    "Native Rev preparation: automatic project exploration, compact prompt, frozen versions, anchor repair, accept/reject/undo, final application, cancellation, error/retry, large review without file selection and dark/light 800px layout passed"
  )
} catch (error) {
  await ui.screenshot("preparation-failure").catch(() => {})
  console.error(await ui.text().catch(() => "No UI"))
  throw error
} finally {
  await ui.stop()
  await f.cleanup()
}
