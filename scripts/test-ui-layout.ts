import assert from "node:assert/strict"
import { NativeUI, fixture } from "../tests/native/ui-driver"

const f = await fixture()
const ui = new NativeUI()
const results: unknown[] = []
async function check(name: string) {
  for (const width of [1440, 1100, 1000, 800]) {
    await ui.resize(width)
    const result = await ui.layout()
    results.push({ name, ...result })
    console.log(name, JSON.stringify(result))
    await ui.screenshot(`layout-${name}-${width}`)
    if (!process.argv.includes("--diagnose")) {
      assert.deepEqual(result.overflow, [], `${name} at ${width}px`)
      assert.deepEqual(
        result.clipped,
        [],
        `Clipped controls: ${name} at ${width}px`
      )
    }
  }
  await ui.resize(1440)
}
try {
  await f.write(
    "src/ExtremelyLongUnbrokenFileNameToExerciseNavigationAndLabelsWithoutHorizontalScrolling.ts",
    "export const description = 'long';\n"
  )
  await ui.start(`${f.root}/appdata`)
  await ui.named("or enter a path")
  await ui.fill('[aria-label="Repository path"]', f.repo)
  await ui.named("Open")
  await ui.reviewScope()
  await ui.click('[role="checkbox"]')
  await ui.startManualReview()
  await ui.until("!!document.querySelector('.monaco-editor')")
  await check("local-changes")
  await ui.named("Document", '[role="tab"]')
  await check("document")
  await ui.named("Contents")
  await check("contents")
  await ui.keys("\uE00C")
  await ui.named("Code", '[role="tab"]')
  await ui.named("Code Explain", '[role="tab"]')
  await check("understand")
  await ui.keys("\uE03D", "k")
  await ui.fill('[role="combobox"]', "Settings")
  await ui.named("Settings", '[role="option"]', false)
  await check("settings")
  await ui.named("Rev", '[role="dialog"] button')
  await check("provider-settings")
  await ui.named("Project", '[role="dialog"] button')
  await check("project-settings")
  await Bun.write(
    `${ui.artifacts}/layouts.json`,
    JSON.stringify(results, null, 2)
  )
} finally {
  await ui.stop()
  await f.cleanup()
}
