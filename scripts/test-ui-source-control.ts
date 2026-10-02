import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { NativeUI, fixture } from "../tests/native/ui-driver"
import { createPreparationHarness } from "../tests/native/preparation-fixture"

process.env.REVIEWBOX_NATIVE_PORT ??= "14475"
process.env.REVIEWBOX_NATIVE_ARTIFACTS ??= "artifacts/validation/source-control"
const ui = new NativeUI()
async function action(name: string) {
  await ui.until(
    `Array.from(document.querySelectorAll('button')).some(e => e.getClientRects().length && e.textContent.replace(/\\s+/g,' ').trim() === ${JSON.stringify(name)} && !e.disabled)`,
    `enabled: ${name}`
  )
  await ui.named(name)
}
const f = await fixture()
const harness = await createPreparationHarness(f.root)
const models = join(f.root, "used-models.jsonl")
await writeFile(
  harness.executable,
  (await readFile(harness.executable, "utf8"))
    .replace(
      "const m=JSON.parse(line);",
      `const m=JSON.parse(line); if(m.method==='thread/start')appendFileSync(${JSON.stringify(models)},JSON.stringify(m.params)+'\\n');`
    )
    .replace(
      "const prompt=m.params.input[0].text;",
      `const prompt=m.params.input[0].text;
appendFileSync(${JSON.stringify(models)},JSON.stringify(m.params)+'\\n');
if(prompt.includes('# Plan the user') || prompt.includes('## Exploration entry points (data)')){
  let output;
  if(prompt.includes('# Plan the user')) {
    const start=prompt.indexOf('\\n{\\n');
    const end=prompt.indexOf('\\n\\nReturn only this JSON',start);
    const context=JSON.parse(prompt.slice(start,end));
    if(!context.stagedDiff.includes('diff --git'))throw Error('Missing frozen staged diff');
    output={commits:context.files.map((file,index)=>({message:'test: staged group '+(index+1),paths:[file.path]}))};
  } else { throw Error('Unexpected non-commit generation'); }
  const finalText=JSON.stringify(output);
  event('item/completed',{type:'agentMessage',id:'note',phase:'commentary',text:'The staged groups are ready.'});
  event('item/started',{type:'agentMessage',id:'final',phase:'final_answer'});
  send({method:'item/agentMessage/delta',params:{itemId:'final',delta:finalText}});
  event('item/completed',{type:'agentMessage',id:'final',phase:'final_answer',text:finalText});
  send({method:'turn/completed',params:{turn:{status:'completed'}}});
  continue;
}`
    )
)
const remote = join(f.root, "remote.git")
await mkdir(remote)
assert.equal(Bun.spawnSync(["git", "init", "--bare", "-q", remote]).exitCode, 0)
f.git("remote", "add", "origin", remote)
// Keep ReviewBox's own setup files out of this code-focused fixture only.
await writeFile(join(f.repo, ".git/info/exclude"), ".reviewbox/\n")
try {
  await ui.start(join(f.root, "appdata"))
  await ui.execute(`window.BASE_UI_ANIMATIONS_DISABLED=true;return true`)
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
  await ui.named("General", "nav button")
  await ui.named("Dark", '[role="tab"]')
  await ui.request(ui.route("/window"), { handle: "main" })
  await ui.named("or enter a path")
  await ui.fill('[aria-label="Repository path"]', f.repo)
  await ui.named("Open")
  await ui.has("Read your changes")
  await ui.named("View local changes")
  await ui.until(`!!document.querySelector('[title="src/answer.ts"]')`)
  await ui.click('[title="src/answer.ts"]')
  await ui.until(
    `!!document.querySelector('[aria-label="Code diff"] .block-diff-main')`
  )
  assert.equal(
    await ui.execute(
      `return getComputedStyle(document.querySelector('[title="src/answer.ts"] > span')).opacity`
    ),
    "1"
  )
  assert.equal(
    await ui.execute(
      `return document.querySelectorAll('[aria-label="Changed files"] [title="src/answer.ts"]').length`
    ),
    2,
    "Partial files appear in both layers"
  )
  assert.equal(
    await ui.execute(
      `return document.querySelectorAll('[aria-label="Changed files"] button[aria-expanded] [data-git-status]').length`
    ),
    0,
    "No status letters on folders"
  )
  await ui.click('[aria-label="Unstaged files"] button[aria-expanded="true"]')
  await ui.until(
    `!document.querySelector('[aria-label="Unstaged files"] [title="src/answer.ts"]')`
  )
  await ui.click('[aria-label="Unstaged files"] button[aria-expanded="false"]')
  await ui.click('[aria-label="Unstaged files"] [title="src/answer.ts"]')
  await ui.until(
    `document.querySelector('.block-diff-main')?.textContent.includes('43')`,
    "initial file rendered"
  )
  assert(!(await ui.text()).includes("Validate file"))
  assert(!(await ui.text()).includes("Contents"))
  await ui.execute(
    `window.__localEditor=document.querySelector('.block-diff-main > .monaco-editor');return true`
  )
  await f.write("src/answer.ts", "export const answer = 43;\n// live update\n")
  await ui.until(
    `document.body.innerText.replace(/\u00a0/g,' ').includes('live update')`
  )
  assert(
    await ui.execute(
      `return window.__localEditor===document.querySelector('.block-diff-main > .monaco-editor')`
    ),
    "An external edit keeps the mounted editor"
  )
  await ui.execute(
    `document.querySelector('.block-diff-main textarea').focus();return true`
  )
  await ui.keys("\uE015")
  await ui.has("Ln 2,")
  await f.write("src/answer.ts", "export const answer = 43;\n")
  await ui.until(
    `!document.body.innerText.replace(/\u00a0/g,' ').includes('live update')`
  )
  const treeWidth = () =>
    ui.execute<number>(
      `return document.querySelector('[aria-label="Local files"]').getBoundingClientRect().width`
    )
  const initialWidth = await treeWidth()
  await ui.click('[aria-label="Resize local files"]')
  await ui.keys("\uE014")
  await ui.wait(
    async () => (await treeWidth()) > initialWidth,
    "keyboard resizing"
  )
  // Exercise the context menu on actual native tree rows.
  const context = async (selector: string) => {
    await ui.execute(
      `const e=document.querySelector(${JSON.stringify(selector)});e.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,button:2,clientX:e.getBoundingClientRect().left+20,clientY:e.getBoundingClientRect().top+10}));return true`
    )
    await ui.until(`!!document.querySelector('[role="menu"]')`)
  }
  const menu = async (name: string) => ui.named(name, '[role="menuitem"]')
  await mkdir(join(f.repo, "menu-test"))
  await f.write("menu-test/a.txt", "one")
  await f.write("menu-test/b.txt", "two")
  await ui.until(`!!document.querySelector('[title="menu-test/b.txt"]')`)
  await ui.click('[title="menu-test/a.txt"]')
  await ui.execute(
    `document.querySelector('[title="menu-test/b.txt"]').dispatchEvent(new MouseEvent('click',{bubbles:true,shiftKey:true}));return true`
  )
  await context('[title="menu-test/b.txt"]')
  await menu("Stage 2 files")
  await ui.until(
    `document.querySelectorAll('[aria-label="Staged files"] [title^="menu-test/"]').length===2`
  )
  await context('[aria-label="Staged files"] [title="menu-test/b.txt"]')
  await ui.keys("\uE00C")
  const folderSelector = '[aria-label="Staged files"] button[aria-expanded]'
  await context(folderSelector)
  await menu("Unstage folder")
  await ui.until(
    `document.querySelectorAll('[aria-label="Unstaged files"] [title^="menu-test/"]').length===2`
  )
  await context('[aria-label="Unstaged files"] button[aria-expanded]')
  await menu("Revert changes")
  await ui.has("Revert unstaged changes?")
  await ui.screenshot("revert-selection")
  await ui.named("Revert changes", '[role="alertdialog"] button')
  await ui.until(`!document.querySelector('[title="menu-test/a.txt"]')`)
  assert(!(await Bun.file(join(f.repo, "menu-test/a.txt")).exists()))
  assert(!(await Bun.file(join(f.repo, "menu-test/b.txt")).exists()))
  assert.equal(
    f.git("show", ":src/answer.ts").trim(),
    "export const answer = 42;"
  )
  await ui.click('[aria-label="Unstaged files"] [title="src/answer.ts"]')
  await ui.until(
    `document.querySelector('.block-diff-main')?.textContent.includes('43')`
  )
  await ui.screenshot("local-changes-dark")
  await ui.named("Staged", '[role="tab"]')
  await action("Unstage file")
  await ui.has("Stage file")
  assert.equal(f.git("diff", "--cached", "--name-only").trim(), "")
  await action("Stage file")
  await ui.until(
    `getComputedStyle(document.querySelector('[title="src/answer.ts"] > span')).opacity==='0.5'`
  )
  await ui.named("Commit · 1")
  await ui.named("Commit manually")
  await ui.fill(
    '[aria-label="Commit message"]',
    "feat: explain the local answer"
  )
  await f.write("src/answer.ts", "export const answer = 44;\n")
  await Bun.sleep(2800)
  assert.equal(
    await ui.execute(
      `return document.querySelector('[aria-label="Commit message"]').value`
    ),
    "feat: explain the local answer",
    "Passive updates keep the open dialog and its draft"
  )
  await ui.named("Create commit")
  await ui.until(`!document.querySelector('[role="dialog"]')`)
  assert.equal(
    f.git("show", "HEAD:src/answer.ts"),
    "export const answer = 43;\n"
  )
  assert.equal(
    await readFile(join(f.repo, "src/answer.ts"), "utf8"),
    "export const answer = 44;\n"
  )
  // The remaining two files are committed as two model-chosen batches.
  for (const path of ["src/other.ts", "src/new.ts"]) {
    await ui.click(`[title="${path}"]`)
    await action("Stage file")
  }
  await ui.named("Commit · 2")
  await ui.named("Commit with Rev")
  await ui.until(`!document.querySelector('[role="dialog"]')`)
  assert.equal(
    f.git("log", "-2", "--format=%s").trim(),
    "test: staged group 2\ntest: staged group 1"
  )
  // Leave the last worktree edit for staging and a final manual commit.
  await ui.click('[title="src/answer.ts"]')
  await action("Stage file")
  await ui.named("Commit · 1")
  await ui.named("Commit manually")
  await ui.fill('[aria-label="Commit message"]', "fix: final value")
  await ui.named("Create commit")
  await ui.has("Read your changes")
  assert(!(await ui.text()).includes("View local changes"))
  await ui.screenshot("overview-dark")
  await ui.execute(
    `document.querySelector('[aria-label^="Inspect commit"]').focus();return true`
  )
  await ui.has("files changed")
  await ui.screenshot("commit-details")
  await ui.keys("\uE00C")
  await ui.named("Publish branch", "button", false)
  await ui.wait(async () => {
    try {
      return (
        f.git("rev-parse", "--abbrev-ref", "@{upstream}").trim() ===
        "origin/main"
      )
    } catch {
      return false
    }
  }, "published branch")
  await ui.has("Remote · origin/main")
  assert.equal(f.git("rev-parse", "HEAD"), f.git("rev-parse", "origin/main"))
  assert.deepEqual(
    await ui.execute(
      `return [...document.querySelector('[aria-label="Last known remote commits"]').querySelectorAll('[style]')].map(e=>e.style.filter)`
    ),
    ["blur(0px)", "blur(1px)", "blur(2px)", "blur(3px)", "blur(4px)"]
  )
  await ui.request(ui.route("/window"), { handle: "settings" })
  await ui.named("General", "nav button")
  await ui.named("Light", '[role="tab"]')
  await ui.request(ui.route("/window"), { handle: "main" })
  await ui.resize(1040, 800)
  await ui.screenshot("overview-light-narrow")
  // Code Explain is a file browser with Markdown/source previews.
  await ui.named("Code Explain", '[role="tab"]')
  await ui.element('[aria-label="Filter files"]')
  await ui.fill('[aria-label="Filter files"]', "README.md")
  await ui.named("README.md", '[aria-label="Snapshot files"] button', false)
  await ui.until(
    "!!document.querySelector('[aria-label=\"Markdown file\"] h1')"
  )
  await ui.named("Markdown preview")
  await ui.until("!!document.querySelector('.monaco-editor')")
  assert(
    !/Explain with Rev|In plain language|Add a section|Go to definition|Explanation outdated/.test(
      await ui.text()
    )
  )
  const reader = await ui.execute<{ editor: number; main: number }>(
    `const main=document.querySelector('main');return {editor:main.querySelector('.monaco-editor').getBoundingClientRect().width,main:main.getBoundingClientRect().width}`
  )
  assert(reader.editor >= reader.main - 4, "Code uses the full reader width")
  await f.write("README.md", "# Changed project\nNew context.\n")
  await ui.until(
    "document.querySelector('[aria-label=\"Markdown file\"] h1')?.textContent === 'Changed project'",
    "live source refresh"
  )
  await ui.element('[aria-label="Filter files"]')
  await ui.screenshot("code-explain-without-review")
  const calls = (await readFile(models, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  assert(
    calls.some((call) => call.model === "gpt-6-luna"),
    "Commit uses the helper model"
  )
  const errors = await ui.execute<string[]>("return window.__uiErrors")
  assert.deepEqual(
    errors.filter(
      (message) =>
        message !==
        "ResizeObserver loop completed with undelivered notifications."
    ),
    []
  )
  console.log(
    "Native source control: staged versions, manual commit, Rev batches, publish, independent Code Explain passed."
  )
} catch (error) {
  await ui.screenshot("failure").catch(() => {})
  console.error(await ui.text().catch(() => "Native view unavailable"))
  throw error
} finally {
  await ui.stop()
  await f.cleanup()
}
