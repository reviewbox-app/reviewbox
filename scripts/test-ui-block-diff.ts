import assert from "node:assert/strict"
import { NativeUI, fixture } from "../tests/native/ui-driver"
import {
  blockBefore,
  blockAfter,
} from "../src/features/development/fixtures/blockDiff.fixture"

process.env.REVIEWBOX_NATIVE_PORT ??= "14479"
process.env.REVIEWBOX_NATIVE_ARTIFACTS ??= "artifacts/validation/block-diff"
const ui = new NativeUI()
const f = await fixture()
await f.write("src/blocks.ts", blockBefore)
f.git("add", "src/blocks.ts")
f.git("commit", "-qm", "Block comparison fixture")
await f.write("src/blocks.ts", blockAfter)
try {
  await ui.start(f.root + "/appdata")
  await ui.named("or enter a path")
  await ui.fill('[aria-label="Repository path"]', f.repo)
  await ui.named("Open")
  await ui.named("View local changes")
  await ui.until(`!!document.querySelector('[title="src/blocks.ts"]')`)
  await ui.click('[title="src/blocks.ts"]')
  await ui.until(
    `!!document.querySelector('[aria-label="Hide previous code"][aria-pressed="true"]')`
  )
  await ui.named("Hide previous code")
  await ui.until(`!!document.querySelector('.block-deletion button')`)
  assert(!(await ui.text()).includes("Unified"))
  assert(!(await ui.text()).includes("previousOnlyValue"))
  await ui.screenshot("current-code")
  await ui.click(".block-deletion button")
  await ui.until(
    `!!document.querySelector('[aria-label="Hide previous code"]')`
  )
  await ui.until(
    `[...document.querySelectorAll('.block-before .view-lines')].some(e=>e.textContent.replace(/\\s/g,' ').includes('previous-only heading'))`
  )
  await ui.named("Find in file")
  await ui.fill('input[aria-label="Find in file"]', "previousOnlyValue")
  await ui.has("1/1")
  await ui.named("Close search")
  const columns = await ui.execute<{ x: number; y: number; height: number }[]>(
    `const row=[...document.querySelectorAll('.block-comparison')].find(e=>e.textContent.includes('currentOnlyValue'));return [...row.children].map(e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,height:r.height}})`
  )
  assert(columns[0].x < columns[1].x)
  assert.equal(columns[0].y, columns[1].y)
  assert.equal(columns[0].height, columns[1].height)
  await ui.until(
    `[...document.querySelectorAll('.block-word-after')].some(e=>e.textContent.includes('currentOnlyValue'))`
  )
  await ui.until(
    `[...document.querySelectorAll('.block-word-before')].some(e=>e.textContent.includes('previousOnlyValue'))`
  )
  const alignment = await ui.execute<{ code: number; numbers: number }>(
    `const root=document.querySelector('.block-diff-main > .monaco-editor > .overflow-guard');
    const current=[...document.querySelectorAll('.block-after')].find(e=>e.textContent.includes('currentOnlyValue'));
    const mainCode=root.querySelector(':scope > .monaco-scrollable-element > .lines-content > .view-lines').getBoundingClientRect();
    const blockCode=current.querySelector('.view-lines').getBoundingClientRect();
    const mainNumbers=root.querySelector(':scope > .margin .line-numbers').getBoundingClientRect();
    const blockNumbers=current.querySelector('.line-numbers').getBoundingClientRect();
    return {code:blockCode.x-mainCode.x,numbers:blockNumbers.right-mainNumbers.right}`
  )
  assert(
    Math.abs(alignment.code) < 1,
    "Current block code aligns with the file"
  )
  assert(
    Math.abs(alignment.numbers) < 1,
    "Current block numbers align with the file"
  )
  await ui.screenshot("block-comparison")
  await ui.request(ui.route("/window/rect"), { width: 900, height: 760 })
  await ui.until(
    `document.querySelector('.block-diff-main').getBoundingClientRect().width<800`
  )
  await ui.screenshot("block-comparison-narrow")
  await ui.named("Hide previous code")
  await ui.until(`!document.querySelector('.block-comparison')`)
  await ui.named("Find in file")
  await ui.fill('input[aria-label="Find in file"]', "previousOnlyValue")
  await ui.has("0 results")
  await ui.fill('input[aria-label="Find in file"]', "currentOnlyValue")
  await ui.has("1/1")
  await ui.named("Close search")
  await ui.execute(
    `document.querySelector('.block-diff-main .monaco-scrollable-element').dispatchEvent(new WheelEvent('wheel',{deltaY:300,bubbles:true,cancelable:true}));return true`
  )
  await ui.until(
    `[...document.querySelectorAll('.block-diff-main .sticky-widget')].some(e=>e.getBoundingClientRect().height>0&&e.textContent.includes('example'))`
  )
  const boundary = await ui.execute<{ top: number; header: number }>(
    `return {top:document.querySelector('.block-diff-main .sticky-widget').getBoundingClientRect().top,header:document.querySelector('[aria-label="Code diff"] header').getBoundingClientRect().bottom}`
  )
  assert(Math.abs(boundary.top - boundary.header) < 2)
  await ui.screenshot("sticky-current")
  console.log(
    "Native block diff: current-only, deletion marker, local comparison, old-source search, narrow columns and sticky passed."
  )
} catch (error) {
  await ui.screenshot("failure").catch(() => {})
  throw error
} finally {
  await ui.stop()
  await f.cleanup()
}
