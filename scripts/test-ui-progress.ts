import assert from "node:assert/strict"
import { chmod, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { NativeUI, fixture } from "../tests/native/ui-driver"

// Default: deterministic app-server subprocess. --live uses the installed Codex
// with its existing authentication, on this disposable repository only.
const live = process.argv.includes("--live")
const f = await fixture()
const ui = new NativeUI()
const mode = join(f.root, "mode")
const executable = live ? Bun.which("codex")! : join(f.root, "codex-fixture")
assert(executable, "Codex is installed")
await writeFile(mode, "wait")
if (!live) {
  await writeFile(
    executable,
    `#!${process.execPath}
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {join} from 'node:path';
const args=process.argv.slice(2), send=value=>console.log(JSON.stringify(value));
if(args[0]==='--version'){console.log('codex-cli 0.157.0');process.exit(0)}
if(args[0]==='login'){console.log('Logged in using ChatGPT');process.exit(0)}
if(args.includes('generate-json-schema')){const out=join(args[args.indexOf('--out')+1],'v2');mkdirSync(out,{recursive:true});writeFileSync(join(out,'ThreadStartParams.json'),JSON.stringify({properties:{ephemeral:{type:['boolean','null']}},definitions:{SandboxMode:{enum:['danger-full-access']}}}));process.exit(0)}
const event=(method,item)=>send({method,params:{item}});
for await(const line of createInterface({input:process.stdin})){
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 if(m.method==='model/list')send({id:m.id,result:{data:[{id:'gpt-6-sol',model:'gpt-6-sol',displayName:'GPT-6 Sol',description:'Fixture',hidden:false,isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'medium',description:'Medium'}],defaultReasoningEffort:'medium'}],nextCursor:null}});
 if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'thread',ephemeral:true}}});
 if(m.method!=='turn/start')continue;
 send({id:m.id,result:{}});
 send({method:'turn/plan/updated',params:{plan:[{step:'Inspect captured changes',status:'inProgress'},{step:'Prepare reading topics',status:'pending'}]}});
 for(let i=0;i<4;i++){event('item/started',{type:'commandExecution',id:'read-'+i,commandActions:[{type:'read'}]});event('item/completed',{type:'commandExecution',id:'read-'+i,commandActions:[{type:'read'}],status:'completed',exitCode:0});}
 event('item/started',{type:'webSearch',id:'unfinished'});
 for(let i=0;i<12;i++)event('item/completed',{type:'agentMessage',id:'note-'+i,phase:'commentary',text:'**Progress note '+i+'**: inspecting captured behavior.'});
 while(readFileSync(${JSON.stringify(mode)},'utf8')==='wait')await Bun.sleep(100);
 event('item/completed',{type:'agentMessage',id:'later',phase:'commentary',text:'**Additional activity** arrived.'});
 while(readFileSync(${JSON.stringify(mode)},'utf8')==='more')await Bun.sleep(100);
 if(readFileSync(${JSON.stringify(mode)},'utf8')==='error'){send({method:'turn/completed',params:{turn:{status:'failed'}}});continue;}
 const text=m.params.input[0].text;
 const pointer=text.split('\\n').find(line=>line.trim().startsWith('"reviewManifest":'));
 const manifest=JSON.parse(readFileSync(JSON.parse(pointer.split(':').slice(1).join(':').trim().replace(/,$/,'')),'utf8'));
 const metadata=manifest.changes.map(c=>JSON.parse(readFileSync(c.metadata,'utf8')));
 const anchor=metadata.find(c=>c.change.path==='src/answer.ts').anchors[0];
 send({method:'turn/plan/updated',params:{plan:[{step:'Inspect captured changes',status:'completed'},{step:'Prepare reading topics',status:'completed'}]}});
 const finalText=JSON.stringify({kind:'topics',topics:[{id:'fixture-topic',title:'Captured behavior',brief:'Review the change.',steps:[{id:'fixture-step',title:'Read the change',explanation:'Inspect the captured value.',anchors:[anchor]}]}]});
 event('item/started',{type:'agentMessage',id:'final',phase:'final_answer'});
 send({method:'item/agentMessage/delta',params:{itemId:'final',delta:finalText.slice(0,-2)}});
 while(readFileSync(${JSON.stringify(mode)},'utf8')==='draft')await Bun.sleep(100);
 send({method:'item/agentMessage/delta',params:{itemId:'final',delta:finalText.slice(-2)}});
 event('item/completed',{type:'agentMessage',id:'final',phase:'final_answer',text:finalText});
 send({method:'turn/completed',params:{turn:{status:'completed'}}});
}
`
  )
  await chmod(executable, 0o700)
}

const history = '[aria-label="Preparation activity history"]'
async function startReview() {
  await ui.until(
    '[...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="Next"&&!b.disabled)'
  )
  await ui.named("Next")
  await ui.has("How should we prepare the reading?")
  await ui.named("With Rev", "label", false)
  await ui.named("Start review")
  await ui.until(
    '!!document.querySelector("[data-testid=preparation-progress]")'
  )
}
let sawLiveDraft = false
async function ready() {
  await ui.wait(
    async () => {
      const error = await ui.execute<string>(
        'return document.querySelector("[role=alert]")?.textContent ?? ""'
      )
      assert(!error, error)
      const state = await ui.execute<{ ready: boolean; draft: boolean }>(
        `return {ready: !!document.querySelector('article[data-topic-id]'), draft: !!document.querySelector('[aria-label="Suggestion draft"]')}`
      )
      if (state.draft && !state.ready) sawLiveDraft = true
      return state.ready
    },
    "Codex topic proposal",
    live ? 180000 : 15000
  )
  await ui.until(
    'document.querySelector("[aria-controls=rev-progress-content]")?.getAttribute("aria-expanded")==="false"'
  )
  assert.equal(
    await ui.execute(`return !!document.querySelector('${history}')`),
    false,
    "successful preparation folds activity"
  )
  await ui.named("Show activity")
  assert(await ui.execute(`return !!document.querySelector('${history}')`))
}
try {
  await ui.start(join(f.root, "appdata"))
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
  await ui.setHarnessExecutable("codex", executable)
  await ui.setDefaultHarness("codex")
  await ui.request(ui.route("/window"), { handle: "main" })
  await ui.named("or enter a path")
  await ui.fill('[aria-label="Repository path"]', f.repo)
  await ui.named("Open")
  await startReview()
  if (!live) {
    await ui.has("Progress note 11")
    await ui.has("4 actions")
    await ui.until(
      `(() => { const e=document.querySelector('${history}');return e.scrollHeight-e.scrollTop-e.clientHeight<=32 })()`,
      "activity follows new entries"
    )
    await ui.until(
      `!document.querySelector('[aria-label="Elapsed time"]').textContent.startsWith('0:00')`,
      "elapsed time advances"
    )
    assert(
      await ui.execute(`return !!document.querySelector('${history} strong')`),
      "commentary renders Markdown"
    )
    await ui.execute(
      `const e=document.querySelector('${history}');e.scrollTop=0;e.dispatchEvent(new Event('scroll'));return true`
    )
    await writeFile(mode, "more")
    await ui.has("Additional activity")
    assert.equal(
      await ui.execute(`return document.querySelector('${history}').scrollTop`),
      0,
      "new events preserve manual scroll position"
    )
    await ui.screenshot("progress-running")
  } else {
    await ui.wait(
      () =>
        ui.execute(
          'return document.querySelectorAll("[aria-label=Activities] li").length>0'
        ),
      "real Codex activity",
      60000
    )
  }
  await ui.named(
    "Cancel",
    '[aria-label="Rev preparation session"] button',
    false
  )
  await ui.has("Preparation stopped. Your frozen review has been kept.")
  assert(
    await ui.execute(`return !!document.querySelector('${history}')`),
    "cancellation retains history"
  )
  if (!live) {
    await ui.has("Interrupted")
    await writeFile(mode, "error")
    await ui.named("Try again")
    await ui.has("Preparation could not finish.")
    await ui.has("Your frozen review is available.")
    assert(
      await ui.execute(`return !!document.querySelector('${history}')`),
      "failure retains history"
    )
    await writeFile(mode, "draft")
  }
  await ui.named("Try again")
  if (!live) {
    await ui.has("1 topic drafted")
    assert.equal(
      await ui.execute(
        'return !!document.querySelector("article[data-topic-id]")'
      ),
      false,
      "draft is not yet a proposal"
    )
    await ui.screenshot("progress-draft")
    await writeFile(mode, "done")
  }
  await ready()
  if (live)
    assert(
      sawLiveDraft,
      "real Codex streams draft progress before its final proposal"
    )
  await ui.named("View files", "main footer button")
  const rows = await ui.execute<string[]>(
    `return [...document.querySelectorAll('[aria-label="Files outside the tour"] li p:first-child')].map(p=>p.textContent)`
  )
  assert.equal(
    rows.filter((path) => path === "src/answer.ts").length,
    1,
    "staged and unstaged changes share one file row"
  )
  assert(
    rows.includes("src/new.ts"),
    "untracked source is present in outside files"
  )
  await ui.named("Close", '[role="dialog"] button')
  await ui.until('!document.querySelector("[role=dialog][data-open]")')
  if (!live) {
    await ui.has("Interrupted") // missing completion is never promoted to success
    assert.equal(
      await ui.execute(
        'return document.querySelectorAll("[aria-label=Activities] strong").length'
      ),
      13,
      "retry clears earlier history"
    )
  }
  for (const [width, height] of [
    [1440, 900],
    [800, 600],
  ]) {
    await ui.resize(width, height)
    assert.deepEqual(
      (await ui.layout()).overflow,
      [],
      `no horizontal overflow at ${width}`
    )
    await ui.screenshot(`progress-${live ? "live" : "fixture"}-${width}`)
  }
  if (!live) {
    await ui.named("Accept", "article[data-topic-id] button")
    await ui.named("View files", "main footer button")
    await ui.has("1 of 2 changes outside accepted topics")
    await ui.named("Close", '[role="dialog"] button')
    await ui.until('!document.querySelector("[role=dialog][data-open]")')
    await ui.named("Add 1 accepted topic")
    await ui.until('!document.querySelector("[data-testid=preparing-review]")')
    await ui.named("files with changes outside the tour", "button", false)
    await ui.named("Outside the tour", '[role="tab"]', false)
    assert.equal(
      await ui.execute(
        `return [...document.querySelectorAll('[aria-label="Coverage"] button')].filter(b=>b.textContent.trim()==='Review file').length`
      ),
      3,
      "outside coverage lists files rather than passages"
    )
  }
  assert.equal(f.git("write-tree"), f.index)
  assert.deepEqual(await ui.execute("return window.__uiErrors"), [])
  console.log(
    `Native preparation progress (${live ? "real Codex" : "fixture"}): activity, cancellation, retry, completion and layout passed`
  )
} catch (error) {
  await ui.screenshot("progress-failure").catch(() => {})
  console.error(await ui.text().catch(() => "No UI"))
  throw error
} finally {
  await ui.stop()
  await f.cleanup()
}
