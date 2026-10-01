import assert from "node:assert/strict"
import { NativeUI, fixture } from "../tests/native/ui-driver"

process.env.REVIEWBOX_NATIVE_PORT ??= "14476"
process.env.REVIEWBOX_NATIVE_ARTIFACTS ??=
  "artifacts/validation/editor-overlays"
const ui = new NativeUI()
const f = await fixture()
const source = (value: number) =>
  `export function outer() {\n  const initial = ${value};\n  if (initial) {\n${Array.from({ length: 160 }, (_, i) => `    const item${i} = initial + ${i};`).join("\n")}\n    return initial;\n  }\n}\n`
await f.write("src/long.ts", source(1))
f.git("add", "src/long.ts")
f.git("commit", "-qm", "Nested source fixture")
await f.write("src/long.ts", source(2))

async function checkWidgets(mode: "Unified" | "Split") {
  await ui.named(mode, "[role=tab]")
  await ui.until(
    "document.querySelector('.modified .view-lines')?.textContent.includes('initial')"
  )
  await ui.execute(`const pane=document.querySelector('.monaco-diff-editor .modified');
    window.__overlayEditor=pane.querySelector('.monaco-editor');
    pane.querySelector('.monaco-scrollable-element').dispatchEvent(new WheelEvent('wheel',{deltaY:600,bubbles:true,cancelable:true}));return true`)
  await ui.until(
    "[...document.querySelectorAll('.modified .sticky-widget')].some(e=>e.getBoundingClientRect().height>0 && e.textContent.includes('outer'))",
    "sticky function context"
  )
  const bounds = await ui.execute<
    { top: number; bottom: number; header: number }[]
  >(`const header=document.querySelector('[aria-label="Code diff"] header').getBoundingClientRect().bottom;
    return [...document.querySelectorAll('.monaco-diff-editor .sticky-widget')].filter(e=>e.getBoundingClientRect().height>0 && e.getBoundingClientRect().width>0).map(e=>({top:e.getBoundingClientRect().top,bottom:e.getBoundingClientRect().bottom,header}))`)
  assert(bounds.length > 0)
  for (const box of bounds)
    assert(
      box.top >= box.header - 1 && box.top <= box.header + 2,
      JSON.stringify(box)
    )
  await ui.named("Find in file")
  await ui.until(
    "!!document.querySelector('.modified .find-widget.visible textarea')"
  )
  await ui.until(
    `(()=>{const input=document.querySelector('.modified .find-widget.visible textarea');if(!input)return false;const r=input.getBoundingClientRect();return r.top>=document.querySelector('[aria-label="Code diff"] header').getBoundingClientRect().bottom && document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===input})()`,
    "search entrance animation finished"
  )
  const search = await ui.execute<{
    top: number
    header: number
    hit: boolean
  }>(
    `const input=document.querySelector('.modified .find-widget.visible textarea'),box=input.getBoundingClientRect();return {top:box.top,header:document.querySelector('[aria-label="Code diff"] header').getBoundingClientRect().bottom,hit:document.elementFromPoint(box.x+box.width/2,box.y+box.height/2)===input}`
  )
  assert(search.top >= search.header, JSON.stringify(search))
  assert(search.hit, "search must be reachable below the glass header")
  await ui.fill(".modified .find-widget.visible textarea", "item120")
  await ui.until(
    "!!document.querySelector('.currentFindMatch')",
    "search finds the requested source"
  )
  await ui.keys("\uE00C")
  await ui.until("!document.querySelector('.modified .find-widget.visible')")
  assert(
    await ui.execute(
      "return window.__overlayEditor === document.querySelector('.monaco-diff-editor .modified .monaco-editor')"
    ),
    "opening and closing search preserves the editor"
  )
  await ui.screenshot(`overlays-${mode.toLowerCase()}`)
}
try {
  await ui.start(`${f.root}/appdata`)
  await ui.execute(`window.BASE_UI_ANIMATIONS_DISABLED=true;
    const frame=window.requestAnimationFrame.bind(window),cancel=window.cancelAnimationFrame.bind(window);
    window.requestAnimationFrame=callback=>document.hidden?-setTimeout(()=>callback(performance.now()),16):frame(callback);
    window.cancelAnimationFrame=id=>id<0?clearTimeout(-id):cancel(id);return true`)
  await ui.named("or enter a path")
  await ui.fill('[aria-label="Repository path"]', f.repo)
  await ui.named("Open")
  await ui.named("View local changes")
  await ui.until("!!document.querySelector('[title=\"src/long.ts\"]')")
  await ui.click('[title="src/long.ts"]')
  await ui.named("Code Explain", "[role=tab]")
  await ui.named("Review", "[role=tab]")
  await ui.until(
    "!!document.querySelector('[aria-label=\"Code diff\"]')",
    "switching tabs keeps the current review view"
  )
  await ui.named("Review", "[role=tab]")
  await ui.has("Read your changes")
  await ui.named("View local changes")
  await ui.click('[title="src/long.ts"]')
  await checkWidgets("Unified")
  // Returning to the file resets the explicitly selected viewport.
  await ui.click('[title="src/answer.ts"]')
  await ui.click('[title="src/long.ts"]')
  await checkWidgets("Split")
  await ui.request(ui.route("/window/rect"), { width: 1000, height: 760 })
  await ui.named("Find in file")
  await ui.until(
    "!!document.querySelector('.modified .find-widget.visible textarea')"
  )
  assert(
    await ui.execute(
      `const e=document.querySelector('.modified .find-widget.visible textarea'),r=e.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===e`
    ),
    "search remains accessible in a narrow window"
  )
  await ui.screenshot("overlays-narrow")
  const errors = await ui.execute<string[]>("return window.__uiErrors")
  assert.deepEqual(
    errors.filter(
      (e) =>
        e !== "ResizeObserver loop completed with undelivered notifications."
    ),
    []
  )
  console.log(
    "Native editor overlays: sticky context and usable search below glass headers, unified/split/narrow; editor preserved."
  )
} catch (error) {
  console.error(
    await ui
      .execute(
        `return [...document.querySelectorAll('.find-widget')].map(e=>({className:e.className,bounds:JSON.stringify(e.getBoundingClientRect()),inputs:[...e.querySelectorAll('textarea')].map(i=>({rect:JSON.stringify(i.getBoundingClientRect()),label:i.getAttribute('aria-label')}))}))`
      )
      .catch(() => [])
  )
  await ui.screenshot("failure").catch(() => {})
  throw error
} finally {
  await ui.stop()
  await f.cleanup()
}
