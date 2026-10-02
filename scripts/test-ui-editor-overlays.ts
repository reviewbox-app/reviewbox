import assert from "node:assert/strict"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { NativeUI, fixture } from "../tests/native/ui-driver"

process.env.REVIEWBOX_NATIVE_PORT ??= "14476"
process.env.REVIEWBOX_NATIVE_ARTIFACTS ??=
  "artifacts/validation/editor-overlays"
const singleFilesOnly = process.argv.includes("--single-files-only")
const ui = new NativeUI()
const f = await fixture()
const source = (value: number) =>
  `export function outer() {\n  const initial = ${value};\n  if (initial) {\n${Array.from({ length: 160 }, (_, i) => `    const item${i} = initial + ${i};`).join("\n")}\n    return initial;\n  }\n}\n`
await f.write("src/deleted.ts", "export const deletedValue = true;\n")
await f.write("REMOVED.md", "# Removed document\n\nPrevious **content**.\n")
await f.write("src/long.ts", source(1))
f.git("add", "src/long.ts", "src/deleted.ts", "REMOVED.md")
f.git("commit", "-qm", "Nested source fixture")
await f.write("src/long.ts", source(2))
await rm(join(f.repo, "src/deleted.ts"))
await rm(join(f.repo, "REMOVED.md"))
await f.write("NEW.md", "# New document\n\nCurrent **content**.\n")

async function checkWidgets(mode: "Current" | "Comparison") {
  if (mode === "Comparison") await ui.named("Show previous code")
  await ui.until(
    "document.querySelector('.block-diff-main .view-lines')?.textContent.includes('initial')"
  )
  const viewport = await ui.execute<{ top: number; header: number }>(
    `return {top:document.querySelector('.block-diff-main > .monaco-editor').getBoundingClientRect().top,header:document.querySelector('[aria-label="Code diff"] header').getBoundingClientRect().bottom}`
  )
  assert(
    Math.abs(viewport.top - viewport.header) <= 1,
    JSON.stringify(viewport)
  )
  // Cross the visible header edge without reaching the old editor origin.
  // A CSS-only widget offset would still show no sticky context here.
  await ui.execute(`const pane=document.querySelector('.block-diff-main');
    window.__overlayEditor=pane.querySelector('.monaco-editor');
    pane.querySelector('.monaco-scrollable-element').dispatchEvent(new WheelEvent('wheel',{deltaY:60,bubbles:true,cancelable:true}));return true`)
  await ui.until(
    "[...document.querySelectorAll('.block-diff-main .sticky-widget')].some(e=>e.getBoundingClientRect().height>0 && e.textContent.includes('outer'))",
    "sticky function context"
  )
  const bounds = await ui.execute<
    { top: number; bottom: number; header: number }[]
  >(`const header=document.querySelector('[aria-label="Code diff"] header').getBoundingClientRect().bottom;
    return [...document.querySelectorAll('.block-diff-main .sticky-widget')].filter(e=>e.getBoundingClientRect().height>0 && e.getBoundingClientRect().width>0).map(e=>({top:e.getBoundingClientRect().top,bottom:e.getBoundingClientRect().bottom,header}))`)
  assert(bounds.length > 0)
  for (const box of bounds)
    assert(
      box.top >= box.header - 1 && box.top <= box.header + 2,
      JSON.stringify(box)
    )
  await ui.named("Find in file")
  await ui.until(
    "!!document.querySelector('input[aria-label=\"Find in file\"]')"
  )
  await ui.until(
    `(()=>{const input=document.querySelector('input[aria-label=\"Find in file\"]');if(!input)return false;const r=input.getBoundingClientRect();return r.top>=document.querySelector('[aria-label="Code diff"] header').getBoundingClientRect().bottom && document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===input})()`,
    "search entrance animation finished"
  )
  const search = await ui.execute<{
    top: number
    header: number
    hit: boolean
  }>(
    `const input=document.querySelector('input[aria-label=\"Find in file\"]'),box=input.getBoundingClientRect();return {top:box.top,header:document.querySelector('[aria-label="Code diff"] header').getBoundingClientRect().bottom,hit:document.elementFromPoint(box.x+box.width/2,box.y+box.height/2)===input}`
  )
  assert(search.top >= search.header, JSON.stringify(search))
  assert(search.hit, "search must be reachable below the glass header")
  await ui.fill('input[aria-label="Find in file"]', "item120")
  await ui.until(
    "document.querySelector('[role=search]')?.textContent.includes('1/1')",
    "search finds the requested source"
  )
  await ui.keys("\uE00C")
  await ui.until("!document.querySelector('[role=search]')")
  assert(
    await ui.execute(
      "return window.__overlayEditor === document.querySelector('.block-diff-main > .monaco-editor')"
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
  if (!singleFilesOnly) {
    await checkWidgets("Current")
    // Returning to the file resets the explicitly selected viewport.
    await ui.click('[title="src/answer.ts"]')
    await ui.click('[title="src/long.ts"]')
    await checkWidgets("Comparison")
    await ui.request(ui.route("/window/rect"), { width: 1000, height: 760 })
    await ui.named("Find in file")
    await ui.until(
      "!!document.querySelector('input[aria-label=\"Find in file\"]')"
    )
    await ui.until(
      `(()=>{const e=document.querySelector('input[aria-label=\"Find in file\"]');if(!e)return false;const r=e.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===e})()`,
      "search remains accessible after its entrance animation in a narrow window"
    )
    const shadow = await ui.execute<string>(
      "return getComputedStyle(document.querySelector('.block-diff-main .sticky-widget')).boxShadow"
    )
    assert(shadow.includes("18px"), shadow)
  }
  for (const mode of ["Current", "Comparison"]) {
    const action =
      mode === "Comparison" ? "Show previous code" : "Hide previous code"
    if (
      await ui.execute(
        `return !!document.querySelector('[aria-label="${action}"]')`
      )
    )
      await ui.named(action)
    for (const [path, needle] of [
      ["src/new.ts", "newValue"],
      ["src/deleted.ts", "deletedValue"],
    ]) {
      await ui.click(`[title="${path}"]`)
      await ui.until(
        `[...document.querySelectorAll('.monaco-editor .view-lines')].some(e=>e.textContent.includes('${needle}'))`
      )
      assert(
        await ui.execute(
          `return !document.querySelector('.monaco-diff-editor') && document.querySelectorAll('.monaco-editor').length===1`
        ),
        `${path}: a single editor, no diff editor`
      )
      assert(
        await ui.execute(
          `return !document.querySelector('[aria-label="Code diff"] [role=tab], [aria-label="Display options"], .line-insert, .line-delete, .char-insert, .char-delete, .review-passage')`
        ),
        `${path}: no diff controls or decorations`
      )
      await ui.named("Find in file")
      await ui.until(
        "!!document.querySelector('.find-widget.visible textarea.input')"
      )
      await ui.fill(".find-widget.visible textarea.input", needle)
      await ui.until(
        "!!document.querySelector('.currentFindMatch')",
        "regular editor search"
      )
      await ui.keys("\uE00C")
      await ui.screenshot(`${needle}-${mode.toLowerCase()}`)
    }
    for (const [path, heading, side] of [
      ["NEW.md", "New document", "after"],
      ["REMOVED.md", "Removed document", "before"],
    ]) {
      await ui.click(`[title="${path}"]`)
      await ui.until(
        `document.querySelector('[aria-label="Code diff"] header')?.textContent.includes('${path}') && document.querySelector('[aria-label="Markdown preview"]')?.disabled===false`
      )
      // A previous pass can have left this file in source mode.
      if (
        await ui.execute(
          `return document.querySelector('[aria-label="Markdown preview"]')?.getAttribute('aria-pressed')==='false'`
        )
      )
        await ui.named("Markdown preview")
      await ui.until(
        `document.querySelector('[aria-label="Markdown file"] h1')?.textContent==='${heading}'`
      )
      assert(
        await ui.execute(
          `const root=document.querySelector('[aria-label="Markdown file"]');return root.querySelector('strong')?.textContent==='content' && !root.querySelector('.document-diff-label, [data-change=added], [data-change=removed], mark') && [...root.querySelectorAll('[data-source-side]')].every(e=>e.dataset.sourceSide==='${side}')`
        ),
        `${path}: complete neutral Markdown on the captured side`
      )
      assert(
        await ui.execute(
          `return !document.querySelector('[aria-label="Code diff"] [role=tab]')`
        )
      )
      await ui.named("Find in file")
      await ui.fill('[aria-label="Find in document"]', "content")
      await ui.until(
        `document.querySelector('[role=search] [role=status]')?.textContent==='1 / 1'`
      )
      await ui.named("Close document search")
      await ui.screenshot(`${path}-${mode.toLowerCase()}`)
      await ui.named("Markdown preview")
      await ui.until(
        `[...document.querySelectorAll('.monaco-editor .view-lines')].some(e=>e.textContent.replaceAll('\\u00a0',' ').includes('${heading}'))`
      )
      assert(
        await ui.execute(
          `return !document.querySelector('.monaco-diff-editor') && document.querySelectorAll('.monaco-editor').length===1`
        )
      )
    }
    await ui.click('[title="src/long.ts"]')
    await ui.until(
      "!!document.querySelector('.block-diff-main > .monaco-editor') && !!document.querySelector('[aria-label=\"Show previous code\"], [aria-label=\"Hide previous code\"]')"
    )
    assert(
      await ui.execute(
        `return !!document.querySelector('[aria-label="${mode === "Comparison" ? "Hide" : "Show"} previous code"]')`
      ),
      "single files preserve the preferred diff layout"
    )
    assert(
      await ui.execute(
        `return [...document.querySelectorAll('.line-insert,.line-delete')].every(e=>getComputedStyle(e).backgroundColor!=='rgba(0, 0, 0, 0)')`
      ),
      "modified files retain diff colors"
    )
  }
  const errors = await ui.execute<string[]>("return window.__uiErrors")
  assert.deepEqual(
    errors.filter(
      (e) =>
        e !== "ResizeObserver loop completed with undelivered notifications."
    ),
    []
  )
  console.log(
    singleFilesOnly
      ? "Native added/deleted files: regular source and Markdown, search, no diff controls or decorations; modified files retain layout and diff colors."
      : "Native editor overlays: sticky context and usable search below glass headers, current/block comparison/narrow; editor preserved; added/deleted files use regular views."
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
