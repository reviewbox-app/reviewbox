import assert from "node:assert/strict"
import { NativeUI, fixture } from "../tests/native/ui-driver"
const f = await fixture()
const ui = new NativeUI()
const code = (value: string) =>
  `export function describe() {\n  return "${value} ${"a readable piece of text ".repeat(140)}";\n}\n`
await f.write("src/wrapped.ts", code("before"))
f.git("add", "src/wrapped.ts")
f.git("commit", "-qm", "Wrap fixture")
await f.write("src/wrapped.ts", code("after"))
try {
  await ui.start(`${f.root}/appdata`)
  await ui.named("or enter a path")
  await ui.fill('[aria-label="Repository path"]', f.repo)
  await ui.named("Open")
  await ui.startManualReview()
  await ui.keys("\uE03D", "k")
  await ui.fill('[role="combobox"]', "wrapped.ts")
  await ui.named("wrapped.ts", '[role="option"]', false)
  await ui.resize(800, 600)
  for (const mode of ["Split", "Unified"]) {
    await ui.named(mode, '[role="tab"]')
    await ui.until(
      'document.querySelectorAll(".monaco-diff-editor .modified .view-line").length > 5',
      "long source line wraps into multiple screen lines"
    )
    const horizontal = await ui.execute<number>(
      `return [...document.querySelectorAll('.monaco-diff-editor .scrollbar.horizontal')].filter(e=>e.classList.contains('visible') && e.getBoundingClientRect().height > 0 && getComputedStyle(e).opacity !== '0').length`
    )
    assert.equal(horizontal, 0, "no horizontal scrollbar for overflowing code")
    await ui.screenshot(`wrapped-${mode.toLowerCase()}`)
  }
  console.log(
    "Native code wrap: long lines wrap in Split and Unified at 800 px without horizontal scrolling"
  )
} finally {
  await ui.stop()
  await f.cleanup()
}
