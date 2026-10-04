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
  // WebKit pauses animation frames in covered windows. Keep the native
  // scrolling/refresh regression running when another app is in front.
  await ui.execute(`window.BASE_UI_ANIMATIONS_DISABLED=true;
    const frame=window.requestAnimationFrame.bind(window),cancel=window.cancelAnimationFrame.bind(window);
    window.requestAnimationFrame=callback=>document.hidden?-setTimeout(()=>callback(performance.now()),16):frame(callback);
    window.cancelAnimationFrame=id=>id<0?clearTimeout(-id):cancel(id);return true;`)
  await ui.until(
    "document.querySelector('header [role=status]')?.textContent.includes('checking') === false",
    "hydration"
  )
  await ui.named("or enter a path")
  await ui.fill('[aria-label="Repository path"]', f.repo)
  await ui.named("Open")
  await ui.startManualReview()
  await ui.until("!!document.querySelector('.monaco-editor')")
  // The palette remains available alongside the optional file list.
  async function openFile(name: string) {
    await ui.keys("\uE03D", "k")
    await ui.fill('[role="combobox"]', name)
    await ui.named(name, '[role="option"]', false)
  }
  await openFile("long.ts")
  await ui.until(
    "document.querySelector('[aria-label=\"Code diff\"] header')?.textContent.includes('long.ts')"
  )
  await ui.until(
    "document.querySelector('.modified .view-lines:not(.line-delete)')?.textContent.includes('item')"
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
  const diff = ".block-diff-main"
  for (const mode of ["Show previous code", "Hide previous code"]) {
    await ui.named(mode)
    await ui.has("+400")
    await Bun.sleep(700)
    const scrolled = await scrollAndWait(diff)
    // Manual reviews without Rev documents use the native completion menu;
    // they no longer expose the guided step/file decision footer.
    assert.equal(
      await ui.execute(
        'return document.querySelectorAll("[aria-label=\\"More decisions\\"]").length'
      ),
      0
    )
    await ui.execute("window.dispatchEvent(new Event('focus'));return true")
    await Bun.sleep(800)
    assert.deepEqual(
      await readViewport(diff),
      scrolled,
      "focus refresh must not recenter the editor"
    )
    await openFile("long.ts")
    await ui.wait(
      async () =>
        (await readViewport(diff)).some(
          (line) => /item1\s/.test(line) && line.includes("'after'")
        ),
      "explicit navigation still recenters the current passage"
    )
    console.log(
      `${mode}: scroll survives save, polling and focus; explicit navigation recenters`
    )
  }
  await ui.named("Code Editor", "[role=tab]")
  await ui.fill('[aria-label="Filter files"]', "long.ts")
  // Code Editor keeps its folders collapsible even when filtering files.
  await ui.named(
    "src",
    '[aria-label="Project files"] button[aria-expanded="false"]',
    false
  )
  await ui.named("long.ts", '[aria-label="Project files"] button', false)
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
