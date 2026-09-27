import assert from "node:assert/strict"
import { NativeUI, fixture } from "../tests/native/ui-driver"

const f = await fixture()
const ui = new NativeUI(process.env.REVIEWBOX_TEST_BINARY)
const code = (value: string) =>
  Array.from(
    { length: 400 },
    (_, i) => `export const item${i + 1} = '${value}';`
  ).join("\n") + "\n"
await f.write("src/long.ts", code("before"))
f.git("add", "src/long.ts")
f.git("commit", "-qm", "Long scroll fixture")
await f.write("src/long.ts", code("after"))
try {
  await ui.start(`${f.root}/appdata`)
  await ui.until(
    "document.querySelector('header [role=status]')?.textContent.includes('checking') === false",
    "hydration"
  )
  await ui.named("or enter a path")
  await ui.fill('[aria-label="Repository path"]', f.repo)
  await ui.named("Open")
  await ui.startManualReview()
  await ui.until("!!document.querySelector('.monaco-editor')")
  await ui.named("long.ts", "aside button", false)
  await ui.until(
    "document.querySelector('[aria-label=\"Code diff\"] header')?.textContent.includes('long.ts')"
  )
  await ui.until(
    "document.querySelector('.monaco-editor .view-lines')?.textContent.includes('item')"
  )
  const readViewport = (selector: string) =>
    ui.execute<string[]>(
      `const pane=document.querySelector(arguments[0]);const box=pane.getBoundingClientRect();return [...pane.querySelectorAll('.view-lines .view-line')].filter(e=>{const r=e.getBoundingClientRect();return r.height>0 && r.top>=box.top && r.bottom<=box.bottom}).sort((a,b)=>a.getBoundingClientRect().top-b.getBoundingClientRect().top).map(e=>e.textContent)`,
      [selector]
    )
  async function scrollAndWait(selector: string) {
    await ui.execute(
      `const pane=document.querySelector(arguments[0]);window.__scrollEditorNode=pane;pane.querySelector('.monaco-scrollable-element').dispatchEvent(new WheelEvent('wheel', {deltaY:300,bubbles:true,cancelable:true}));return true`,
      [selector]
    )
    // Let wheel animation settle and the 500 ms position save complete.
    await Bun.sleep(1000)
    const scrolled = await readViewport(selector)
    assert(
      scrolled.length > 0 && !/item1\s/.test(scrolled[0]),
      "scroll must survive the automatic position save"
    )
    await Bun.sleep(3200)
    assert.deepEqual(
      await readViewport(selector),
      scrolled,
      "background polling must preserve the viewport"
    )
    assert(
      await ui.execute(
        "return document.querySelector(arguments[0]) === window.__scrollEditorNode",
        [selector]
      ),
      "editor must remain mounted"
    )
    return scrolled
  }
  const diff = ".monaco-diff-editor .modified"
  for (const mode of ["Split", "Unified"]) {
    await ui.named(mode, "[role=tab]")
    await ui.has("+400")
    await Bun.sleep(700)
    const scrolled = await scrollAndWait(diff)
    await ui.named(mode === "Split" ? "Validate passage" : "Reopen passage")
    await Bun.sleep(800)
    assert.deepEqual(
      await readViewport(diff),
      scrolled,
      "human review actions must not recenter the editor"
    )
    await ui.execute("window.dispatchEvent(new Event('focus'));return true")
    await Bun.sleep(800)
    assert.deepEqual(
      await readViewport(diff),
      scrolled,
      "focus refresh must not recenter the editor"
    )
    await ui.named("long.ts", "aside button", false)
    await ui.wait(
      async () =>
        (await readViewport(diff)).some(
          (line) => /item1\s/.test(line) && line.includes("'after'")
        ),
      "explicit navigation still recenters the current passage"
    )
    console.log(
      `${mode}: scroll survives save, polling, validation and focus; explicit navigation recenters`
    )
  }
  await ui.named("Understand", "[role=tab]")
  await ui.fill('[aria-label="Filter files"]', "long.ts")
  await ui.named("long.ts", '[aria-label="Snapshot files"] button', false)
  await ui.until(
    "document.querySelector('.monaco-editor .view-lines')?.textContent.includes('item')"
  )
  await Bun.sleep(700)
  await scrollAndWait(".monaco-editor")
  assert.deepEqual(await ui.execute("return window.__uiErrors"), [])
  console.log(
    "Understand: scroll survives knowledge polling. Native Monaco regression passed."
  )
} catch (e) {
  console.error((await ui.text().catch(() => "")).slice(0, 1200))
  await ui.screenshot("scroll-failure").catch(() => {})
  throw e
} finally {
  await ui.stop()
  await f.cleanup()
}
