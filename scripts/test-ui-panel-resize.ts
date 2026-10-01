import assert from "node:assert/strict"
import { join } from "node:path"
import { NativeUI, fixture } from "../tests/native/ui-driver"

process.env.REVIEWBOX_NATIVE_PORT ??= "14463"
process.env.REVIEWBOX_NATIVE_ARTIFACTS ??= "artifacts/validation/panel-resize"
const f = await fixture()
const ui = new NativeUI()
const keys = [
  "reviewbox.panel-width.--review-files-width",
  "reviewbox.panel-width.--explain-files-width",
]
let saved: (string | null)[] = []
const handle = (name: string) => `[role=separator][aria-label="Resize ${name}"]`
const width = (name: string) =>
  ui.execute<number>(
    `return (arguments[1] === "review files" ? document.querySelector('aside[aria-label="Review files"]') : document.querySelector(arguments[0]).parentElement).getBoundingClientRect().width`,
    [handle(name), name]
  )
async function drag(name: string, distance: number) {
  // WebDriver 1.4 emits MouseEvents only. Supply the missing PointerEvents to
  // the actual native DOM handlers; synthetic pointers have no OS capture ID.
  await ui.execute(
    `const el=document.querySelector(arguments[0]),r=el.getBoundingClientRect();
    const capture=el.setPointerCapture,release=el.releasePointerCapture;
    el.setPointerCapture=()=>{};el.releasePointerCapture=()=>{};
    try { for(const [type,x] of [['pointerdown',r.x],['pointermove',r.x+arguments[1]],['pointerup',r.x+arguments[1]]])
      el.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:1,button:0,clientX:x,clientY:r.y+100}));
    } finally {el.setPointerCapture=capture;el.releasePointerCapture=release;} return true`,
    [handle(name), distance]
  )
}
async function keyboard(name: string, key: string) {
  await ui.execute(
    `const el=document.querySelector(arguments[0]);el.focus();el.dispatchEvent(new KeyboardEvent('keydown',{key:arguments[1],bubbles:true,cancelable:true}));return true`,
    [handle(name), key]
  )
}
try {
  await ui.start(join(f.root, "appdata"))
  saved = await ui.execute(
    "return arguments[0].map(key=>localStorage.getItem(key))",
    [keys]
  )
  await ui.execute(
    "arguments[0].forEach(key=>localStorage.removeItem(key));return true",
    [keys]
  )
  await ui.named("or enter a path")
  await ui.fill('[aria-label="Repository path"]', f.repo)
  await ui.named("Open")
  await ui.startManualReview()
  assert(
    await ui.execute(
      `return !document.querySelector('[aria-label="Reading level"], button[aria-label="Explanation"], button[aria-label="Contents"]')`
    ),
    "document controls hidden without authored steps"
  )
  await ui.resize(1440, 900)
  await ui.named("Files")
  await ui.element(handle("review files"))
  await ui.until(
    `document.querySelector('aside[aria-label="Review files"]').getBoundingClientRect().width >= 239`
  )
  const layout = await ui.execute<{
    outside: boolean
    gap: number
    edge: number
  }>(
    `const tree=document.querySelector('aside[aria-label="Review files"]'),shell=document.querySelector('main[aria-label="Review"]'),handle=document.querySelector(arguments[0]),t=tree.getBoundingClientRect(),s=shell.getBoundingClientRect(),h=handle.getBoundingClientRect();return {outside:!shell.contains(tree),gap:s.left-t.right,edge:Math.abs(h.left+h.width/2-s.left)}`,
    [handle("review files")]
  )
  assert(
    layout.outside && Math.abs(layout.gap - 8) < 1 && layout.edge < 1,
    JSON.stringify(layout)
  )
  const initial = await width("review files")
  await ui.execute(
    "window.__resizeEditor=document.querySelector('.monaco-editor');return true"
  )
  await drag("review files", 70)
  assert(Math.abs((await width("review files")) - initial - 70) < 2)
  await ui.until(
    `document.querySelector('${handle("review files")}').getAttribute('aria-valuenow')==='${Math.round(initial + 70)}'`
  )
  assert(
    await ui.execute(
      "return window.__resizeEditor===document.querySelector('.monaco-editor')"
    ),
    "editor remains mounted"
  )
  await keyboard("review files", "ArrowLeft")
  const remembered = await width("review files")
  assert(Math.abs(remembered - initial - 60) < 2)
  await ui.execute(
    `window.__resizeTree=document.querySelector('aside[aria-label="Review files"] nav');return true`
  )
  await ui.execute(
    `window.__treeWidths=[];const start=performance.now();function sample(){window.__treeWidths.push(document.querySelector('aside[aria-label="Review files"]').getBoundingClientRect().width);if(performance.now()-start<800 && window.__treeWidths.at(-1)>0)requestAnimationFrame(sample)}requestAnimationFrame(sample);return true`
  )
  await ui.named("Files")
  await ui.until(
    `document.querySelector('aside[aria-label="Review files"]').getBoundingClientRect().width === 0`
  )
  assert(
    await ui.execute(
      `return matchMedia('(prefers-reduced-motion: reduce)').matches || window.__treeWidths.some(width=>width>1 && width<arguments[0]-1)`,
      [remembered]
    ),
    "tree slides through intermediate widths"
  )
  assert(
    await ui.execute(
      `return document.querySelector('aside[aria-label="Review files"]').inert`
    ),
    "closed tree is not keyboard accessible"
  )
  await ui.named("Files")
  await ui.until(
    `Math.abs(document.querySelector('aside[aria-label="Review files"]').getBoundingClientRect().width-${remembered}) < 1`
  )
  assert(
    await ui.execute(
      `return window.__resizeTree === document.querySelector('aside[aria-label="Review files"] nav') && window.__resizeEditor === document.querySelector('.monaco-editor')`
    ),
    "toggle preserves tree and editor"
  )
  assert(Math.abs((await width("review files")) - remembered) < 2)
  assert(
    await ui.execute(
      `const shell=document.querySelector('main[aria-label="Review"]'),r=shell.getBoundingClientRect(),h=document.querySelector(arguments[0]);return [-2,0,2].every(x=>document.elementFromPoint(r.left+x,r.top+48)===h)`,
      [handle("review files")]
    ),
    "shell border is the resize hit area"
  )
  await ui.screenshot("review-resized")
  await ui.resize(800, 900)
  assert(
    (await width("review files")) < remembered,
    "Review tree clamps in narrow windows"
  )
  await ui.resize(1440, 900)
  await ui.until(
    `Math.abs(document.querySelector('aside[aria-label="Review files"]').getBoundingClientRect().width-${remembered})<1`
  )
  await ui.named("Code Explain", "[role=tab]")
  await ui.element(handle("Code Explain files"))
  const explainInitial = await width("Code Explain files")
  await drag("Code Explain files", 60)
  assert(
    Math.abs((await width("Code Explain files")) - explainInitial - 60) < 2
  )
  await keyboard("Code Explain files", "Home")
  assert.equal(await width("Code Explain files"), 180)
  await keyboard("Code Explain files", "ArrowRight")
  assert.equal(await width("Code Explain files"), 190)
  await keyboard("Code Explain files", "End")
  const wide = await width("Code Explain files")
  await ui.resize(800, 900)
  assert(
    (await width("Code Explain files")) < wide,
    "narrow window clamps tree"
  )
  await ui.resize(1440, 900)
  assert(
    Math.abs((await width("Code Explain files")) - wide) < 2,
    "wide preference restored"
  )
  await ui.screenshot("code-explain-resized")
  await ui.named("Review", "[role=tab]")
  await ui.until(
    `Math.abs(document.querySelector('aside[aria-label="Review files"]').getBoundingClientRect().width-${remembered}) < 1`
  )
  assert(
    Math.abs((await width("review files")) - remembered) < 2,
    "separate widths survive navigation"
  )
  await ui.named("Document", "[role=tab]")
  await ui.element('[aria-label="Review document"] [data-slot="empty"]')
  const centered = await ui.execute<{ horizontal: number; vertical: number }>(
    `const view=document.querySelector('[aria-label="Review document"]'), empty=view.querySelector('[data-slot="empty"]'), v=view.getBoundingClientRect(),e=empty.getBoundingClientRect(),s=getComputedStyle(view);return {horizontal:Math.abs(e.x+e.width/2-v.x-v.width/2),vertical:Math.abs(e.y+e.height/2-(v.y+parseFloat(s.paddingTop)+(v.height-parseFloat(s.paddingTop)-parseFloat(s.paddingBottom))/2))}`
  )
  assert(
    centered.horizontal < 2 && centered.vertical < 2,
    JSON.stringify(centered)
  )
  await ui.screenshot("empty-document-centered")
  assert.deepEqual(await ui.execute("return window.__uiErrors"), [])
  console.log(
    "Native panel resize: drag handlers, keyboard, bounds, persistence, independent widths and mounted editor passed."
  )
} catch (error) {
  console.error(
    await ui
      .execute(
        `return [...document.querySelectorAll('aside[aria-label="Review files"]')].map(el=>({width:el.getBoundingClientRect().width,grid:getComputedStyle(el.parentElement).gridTemplateColumns,style:el.parentElement.getAttribute("style")}))`
      )
      .catch(() => null)
  )
  console.error(await ui.text().catch(() => ""))
  await ui.screenshot("failure").catch(() => {})
  throw error
} finally {
  if (saved.length)
    await ui
      .execute(
        "arguments[0].forEach((key,i)=>arguments[1][i]===null?localStorage.removeItem(key):localStorage.setItem(key,arguments[1][i]));return true",
        [keys, saved]
      )
      .catch(() => {})
  await ui.stop()
  await f.cleanup()
}
