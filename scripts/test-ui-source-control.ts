import assert from "node:assert/strict"
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  utimes,
  writeFile,
} from "node:fs/promises"
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
const live = process.argv.includes("--live")
const harness = await createPreparationHarness(f.root, live)
const recovery = process.argv.includes("--recovery")
const large = process.argv.includes("--large")
const noReasoning = process.argv.includes("--none")
const models = join(f.root, "used-models.jsonl")
if (!live)
  await writeFile(
    harness.executable,
    (await readFile(harness.executable, "utf8"))
      .replace(
        "reasoningEffort:'high'",
        noReasoning ? "reasoningEffort:'none'" : "reasoningEffort:'high'"
      )
      .replace(
        "const m=JSON.parse(line);",
        `const m=JSON.parse(line); if(m.method==='thread/unload'){send({id:m.id,result:{}});continue;} if(m.method==='config/read'){send({id:m.id,result:{config:{}}});continue;} if(m.method==='thread/start')appendFileSync(${JSON.stringify(models)},JSON.stringify(m.params)+'\\n');`
      )
      .replace(
        "const prompt=m.params.input[0].text;",
        `const prompt=m.params.input[0].text;
appendFileSync(${JSON.stringify(models)},JSON.stringify(m.params)+'\\n');
if(prompt.includes('Perform this user-requested Git operation')){
  if(m.params.outputSchema)throw Error('Commit execution must not require a plan schema');
  const git=(...args)=>{const result=Bun.spawnSync(['git',...args],{cwd:process.cwd()});if(result.exitCode!==0)throw Error(result.stderr.toString());return result.stdout.toString();};
  try {
    event('item/started',{type:'commandExecution',id:'git-commit',commandActions:[{type:'unknown'}]});
    if(prompt.includes('Stage and commit all saved'))git('add','-A');
    const files=git('diff','--cached','--name-only','-z').split('\\0').filter(Boolean);
    for(const [index,file] of files.entries()){
      git('commit','--only','-qm','test: staged group '+(index+1),'--',file);
      await Bun.sleep(2500);
    }
    if(Bun.file('generated-by-hook.txt').size){git('add','generated-by-hook.txt');git('commit','-qm','chore: apply git hook changes');}
    event('item/completed',{type:'commandExecution',id:'git-commit',status:'completed',exitCode:0});
    event('item/completed',{type:'agentMessage',id:'final',phase:'final_answer',text:'Commits created with Git.'});
    send({method:'turn/completed',params:{turn:{status:'completed'}}});
  } catch(error) {
    send({method:'turn/completed',params:{turn:{status:'failed',error:{message:String(error)}}}});
  }
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
if (recovery) {
  // An already tracked source beneath a newly ignored directory must still stage.
  await writeFile(join(f.repo, ".git/info/exclude"), ".reviewbox/\nsrc/\n")
  await f.write("src/private.txt", "must remain ignored\n")
}
if (large)
  await f.write(
    "src/answer.ts",
    "export const amount = 42;\n" +
      "// changed value and dependent behavior\n".repeat(1800)
  )
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
  if (process.argv.includes("--review-commit")) {
    await ui.startManualReview()
    const [reviewId] = await readdir(join(f.repo, ".reviewbox/.local/reviews"))
    assert(reviewId)
    await ui.named("End review")
    await ui.has("Review summary")
    await ui.named("Home", '[role="tab"]')
    await ui.named("Review actions")
    await ui.named("Keep this review local", '[role="menuitemcheckbox"]')
    await ui.keys("\uE00C")
    await ui.until('!document.querySelector("[role=menu]")')
    await ui.wait(async () => {
      const saved = JSON.parse(
        await readFile(
          join(
            f.repo,
            ".reviewbox/.local/reviews",
            reviewId,
            "reviews",
            reviewId,
            "review.json"
          ),
          "utf8"
        )
      )
      return saved.data.publication.keepLocal === true
    }, "local setting saved")
    await ui.named("Review actions")
    await ui.named("Complete review", '[role="menuitem"]', false)
    await ui.has("Completed and kept local.")
    await f.write("untracked-after-review.txt", "included\n")
    await f.write("ignored-hook-test.txt", "ignored\n")
    await writeFile(
      join(f.repo, ".git/info/exclude"),
      ".reviewbox/\nignored-hook-test.txt\n"
    )
    const hook = join(f.repo, ".git/hooks/post-commit")
    await writeFile(
      hook,
      "#!/bin/sh\nprintf 'hook output\\n' > generated-by-hook.txt\n"
    )
    await chmod(hook, 0o755)
    await action("Stage & commit with Rev")
    await ui.named("Home", '[role="tab"]')
    await ui.named("Review", '[role="tab"]')
    await ui.wait(
      async () => (await ui.text()).includes("Read your changes"),
      "review commits completed",
      120000
    )
    assert.equal(
      f.git("show", "HEAD:untracked-after-review.txt").trim(),
      "included"
    )
    assert.equal(
      f.git("show", "HEAD:generated-by-hook.txt").trim(),
      "hook output"
    )
    assert.equal(f.git("ls-files", "--", "ignored-hook-test.txt").trim(), "")
    assert.equal(f.git("diff", "--cached", "--name-only").trim(), "")
    assert(
      f.git("log", "--format=%s").includes("chore: apply git hook changes")
    )
    assert.equal(
      f.git("ls-remote", "--heads", "origin").trim(),
      "",
      "No implicit push"
    )
    await ui.screenshot("review-stage-and-commit-hooks")
    console.log(
      "Native review commit: completed summary, stage all saved changes, ignored file excluded, hook follow-up and clean index passed."
    )
  } else {
    await ui.named("View local changes")
    if (
      await ui.execute(
        `return !!document.querySelector('[data-folder="src"][aria-expanded="false"]')`
      )
    )
      await ui.click('[data-folder="src"]')
    await ui.until(`!!document.querySelector('[title="src/answer.ts"]')`)
    if (process.argv.includes("--commit-only")) {
      await ui.click('[title="src/answer.ts"]')
      if (recovery) {
        const lock = join(f.repo, ".git/index.lock")
        await writeFile(lock, "")
        const old = new Date(Date.now() - 60000)
        await utimes(lock, old, old)
        await action("Stage file")
        await ui.has("Recover Git lock")
        // Background Git reads may transiently make conservative recovery refuse.
        for (let attempt = 0; attempt < 10; attempt++) {
          await action("Recover Git lock")
          await Bun.sleep(500)
          if (!(await ui.text()).includes("Recover Git lock")) break
        }
        await ui.until(`!document.body.innerText.includes('Recover Git lock')`)
        assert(
          (await readdir(join(f.repo, ".git/reviewbox-lock-backups")))
            .length === 1
        )
      }
      await action("Stage file")
      assert.equal(f.git("ls-files", "--", "src/private.txt").trim(), "")
      await action("Commit · 1")
      const testHooks = process.argv.includes("--hooks")
      const testFailure = process.argv.includes("--hook-failure")
      if (testFailure) {
        const hook = join(f.repo, ".git/hooks/pre-commit")
        await writeFile(
          hook,
          "#!/bin/sh\necho 'Hook rejected the commit' >&2\nexit 1\n"
        )
        await chmod(hook, 0o755)
      }
      if (testHooks) {
        const hook = join(f.repo, ".git/hooks/post-commit")
        await writeFile(
          hook,
          "#!/bin/sh\nprintf 'hook output\\n' > generated-by-hook.txt\n"
        )
        await chmod(hook, 0o755)
      }
      const started = performance.now()
      await ui.named("Commit with Rev")
      if (!testFailure && !live) {
        await ui.has("1 commits observed in Git. Rev is working…")
        await ui.screenshot("rev-commit-observed-live")
      }
      if (testFailure) {
        await ui.has("Hook rejected the commit")
        if (recovery) {
          const before = f.git("rev-parse", "HEAD")
          await action("Clear previous plans")
          await ui.until(
            `!document.body.innerText.includes('Hook rejected the commit')`
          )
          assert.equal(f.git("rev-parse", "HEAD"), before)
        }
        assert.equal(
          await ui.execute(
            `return document.body.innerText.includes("Preparation could not finish.")`
          ),
          false
        )
        assert.equal(
          f.git("diff", "--cached", "--name-only").trim(),
          "src/answer.ts"
        )
      } else {
        await ui.wait(
          async () =>
            await ui.execute<boolean>(
              `return !document.querySelector('[role="dialog"]')`
            ),
          "commit finished",
          live ? 120000 : 12000
        )
        if (!live)
          assert.equal(
            f.git("log", "-1", "--format=%s").trim(),
            testHooks ? "chore: apply git hook changes" : "test: staged group 1"
          )
        assert.equal(f.git("diff", "--cached", "--name-only").trim(), "")
        assert.equal(f.git("ls-remote", "--heads", "origin").trim(), "")
      }
      if (testHooks) {
        assert.equal(
          f.git("log", "-2", "--format=%s").trim(),
          "chore: apply git hook changes\ntest: staged group 1"
        )
        assert.equal(
          f.git("show", "HEAD:generated-by-hook.txt").trim(),
          "hook output"
        )
        assert.equal(f.git("diff", "--cached", "--name-only").trim(), "")
      }
      if (!live) {
        const records = (await readFile(models, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
        assert(
          records
            .filter((record) => record.input)
            .every((record) => record.effort === (noReasoning ? "none" : "low"))
        )
        assert.equal(
          records.filter((record) => record.input).length,
          1,
          "One autonomous turn, no per-file host planning passes"
        )
        assert(
          records.some((record) => record.sandbox === "danger-full-access")
        )
        assert(
          records
            .filter((record) => record.input)
            .every((record) => !record.outputSchema)
        )
      }
      if (testHooks || testFailure)
        await ui.screenshot(
          testFailure ? "hook-failure-plan-prepared" : "hook-changes-committed"
        )
      console.log("Commit duration ms", Math.round(performance.now() - started))
      console.log(
        "Native Rev commit: provider executes Git directly; real commits, effort and failures observed."
      )
    } else {
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
      await ui.click(
        '[aria-label="Unstaged files"] button[aria-expanded="true"]'
      )
      await ui.until(
        `!document.querySelector('[aria-label="Unstaged files"] [title="src/answer.ts"]')`
      )
      await ui.click(
        '[aria-label="Unstaged files"] button[aria-expanded="false"]'
      )
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
      await f.write(
        "src/answer.ts",
        "export const answer = 43;\n// live update\n"
      )
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
      await ui.wait(
        async () =>
          await ui.execute<boolean>(
            `return !document.querySelector('[role="dialog"]')`
          ),
        "commit finished",
        live ? 120000 : 12000
      )
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
      await ui.wait(
        async () =>
          await ui.execute<boolean>(
            `return !document.querySelector('[role="dialog"]')`
          ),
        "commit finished",
        live ? 120000 : 12000
      )
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
      assert.equal(
        f.git("rev-parse", "HEAD"),
        f.git("rev-parse", "origin/main")
      )
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
      // Code Editor is a file browser with Markdown/source previews.
      await ui.named("Code Editor", '[role="tab"]')
      await ui.element('[aria-label="Filter files"]')
      await ui.fill('[aria-label="Filter files"]', "README.md")
      await ui.named("README.md", '[aria-label="Project files"] button', false)
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
      assert(
        reader.editor >= reader.main - 4,
        "Code uses the full reader width"
      )
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
        "Native source control: staged versions, manual commit, Rev batches, publish, independent Code Editor passed."
      )
    }
  }
} catch (error) {
  await ui.screenshot("failure").catch(() => {})
  console.error(await ui.text().catch(() => "Native view unavailable"))
  throw error
} finally {
  await ui.stop()
  await f.cleanup()
}
