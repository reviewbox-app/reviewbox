import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { NativeUI, fixture } from "../tests/native/ui-driver"
import { createPreparationHarness } from "../tests/native/preparation-fixture"

process.env.REVIEWBOX_NATIVE_PORT ??= "14488"
process.env.REVIEWBOX_NATIVE_ARTIFACTS ??= "artifacts/validation/document-chat"
const f = await fixture()
const ui = new NativeUI()
const harness = await createPreparationHarness(f.root, false, 2)
const chatCalls = join(f.root, "chat-calls.jsonl")
let executable = await readFile(harness.executable, "utf8")
executable = executable.replace(
  "if(m.method==='initialize')",
  "if(m.method==='config/read')send({id:m.id,result:{config:{}}});\n if(m.method==='initialize')"
)
executable = executable.replace(
  "const prompt=m.params.input[0].text;",
  `const prompt=m.params.input[0].text;
 if(prompt.includes('Conversation and captured-source manifest paths:')) {
  if(m.params.sandboxPolicy?.type!=='readOnly')throw Error('Chat must be read-only');
  const input=JSON.parse(prompt.split('Conversation and captured-source manifest paths:\\n')[1].split('\\n\\n')[0]);
  const conversation=JSON.parse(readFileSync(input.conversation,'utf8'));
  if(!conversation.messages.at(-1).document.body)throw Error('Missing full document');
  if(prompt.includes('The [value]'))throw Error('Unexpected document inline injection');
  appendFileSync(${JSON.stringify(chatCalls)},JSON.stringify(conversation)+'\\n');
  const answer='This assignment gives the updated value its name. The captured document explains its effect.';
  event('item/started',{type:'agentMessage',id:'chat',phase:'final_answer'});
  send({method:'item/agentMessage/delta',params:{itemId:'chat',delta:answer.slice(0,25)}});
  await Bun.sleep(700);
  send({method:'item/agentMessage/delta',params:{itemId:'chat',delta:answer.slice(25)}});
  event('item/completed',{type:'agentMessage',id:'chat',phase:'final_answer',text:answer});
  send({method:'turn/completed',params:{turn:{status:'completed'}}});
  continue;
 }
`
)
await writeFile(harness.executable, executable)
await writeFile(harness.mode, "done")
const notes = join(f.repo, ".reviewbox/.local/REVIEW_COMMENTS.md")
async function selectText() {
  await ui.execute(
    `const spans=[...document.querySelectorAll('[data-review-document] [data-document-start]')];const range=document.createRange();range.setStart(spans[0].firstChild,0);range.setEnd(spans[2].firstChild,spans[2].textContent.length);window.getSelection().removeAllRanges();window.getSelection().addRange(range);document.dispatchEvent(new Event('selectionchange'));return true`
  )
  await ui.until(
    `!!document.querySelector('[aria-label="Document selection"]')`
  )
}
try {
  await ui.start(join(f.root, "appdata"))
  await ui.resize(1440, 900)
  await ui.named("or enter a path")
  await ui.fill('[aria-label="Repository path"]', f.repo)
  await ui.named("Open")
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
  await ui.activateWindow()
  await ui.reviewScope()
  await ui.nextReviewStep()
  await ui.named("With Rev", "label", false)
  await ui.named("Start review", "[role=dialog] footer button")
  await ui.wait(
    async () => (await ui.text()).includes("Your review is ready"),
    "review ready",
    90000
  )
  await ui.named("Start review")
  await ui.until(
    `document.querySelectorAll('[data-review-document] [data-document-start]').length > 2`
  )
  await ui.execute("window.__uiErrors=[];return true")
  await selectText()
  await ui.named("Add comment", '[aria-label="Document selection"] button')
  await ui.fill(
    '[aria-label="Review comment"]',
    "Explain this document passage more clearly."
  )
  await ui.named("Save comment")
  await ui.wait(
    async () =>
      (await readFile(notes, "utf8").catch(() => "")).includes(
        "Explain this document passage"
      ),
    "document comment saved"
  )
  const markdown = await readFile(notes, "utf8")
  assert(markdown.includes('"document":'))
  await selectText()
  await ui.named("Ask Rev", '[aria-label="Document selection"] button')
  assert.equal(await readFile(chatCalls, "utf8").catch(() => ""), "")
  await ui.fill('[aria-label="Message to Rev"]', "Explain this passage")
  await ui.named("Send", '[aria-label="Ask Rev"] button')
  await ui.has("This assignment gives")
  await ui.click('[aria-label="Minimize Rev chat"]')
  await ui.wait(
    async () => (await ui.text()).includes("New reply"),
    "unread response"
  )
  await ui.click('[aria-label="Ask Rev — unread response"]')
  await ui.has("The captured document explains its effect.")
  await ui.fill('[aria-label="Message to Rev"]', "Preserve my draft")
  await ui.click('[aria-label="Minimize Rev chat"]')
  await ui.named("assignment", "[data-review-document] button")
  await ui.named("Ask Rev", '[role="dialog"] button')
  await ui.wait(
    async () =>
      (await readFile(chatCalls, "utf8")).trim().split("\n").length === 2,
    "glossary question sent"
  )
  assert.equal(
    await ui.execute(
      `return document.querySelector('[aria-label="Message to Rev"]').value`
    ),
    "Preserve my draft"
  )
  const calls = (await readFile(chatCalls, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  assert.equal(calls[0].messages[0].selection.ranges.length > 0, true)
  assert.equal(calls[1].messages.at(-1).term.term, "assignment")
  assert.equal(
    calls[1].messages.at(-1).message,
    "Explain what “assignment” means in this context."
  )
  await ui.has("The captured document explains its effect.")
  await ui.until(
    `![...document.querySelectorAll('[aria-label="Ask Rev"] button')].some(b=>b.textContent.trim() === "Stop")`,
    "glossary response complete"
  )
  await ui.screenshot("document-chat-dark")
  await ui.execute(
    `document.documentElement.classList.remove('dark');document.documentElement.classList.add('light');return true`
  )
  await ui.screenshot("document-chat-light")
  assert.deepEqual(
    await ui.execute(
      "return (window.__uiErrors ?? []).filter(e=>!e.includes('ResizeObserver loop'))"
    ),
    []
  )
  console.log(
    "Native document comments and Ask Rev: selection, persistence, full context, streaming, minimize/unread, glossary auto-send and preserved draft passed."
  )
} catch (error) {
  await ui.screenshot("failed-document-chat").catch(() => {})
  throw error
} finally {
  await ui.stop()
  await f.cleanup()
}
