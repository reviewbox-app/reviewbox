import assert from "node:assert/strict"
import { join } from "node:path"
import { NativeUI, fixture } from "../tests/native/ui-driver"

// Run against the next validation binary; does not build or install the app.
process.env.REVIEWBOX_NATIVE_PORT ??= "14483"
process.env.REVIEWBOX_NATIVE_ARTIFACTS ??= "artifacts/validation/read-cache"
const f = await fixture()
const ui = new NativeUI()
await f.write(
  "notes.TXT",
  "# Cache fixture\n\n" +
    Array.from(
      { length: 100 },
      (_, i) => `## Section ${i}\n\nParagraph ${i}\n\n`
    ).join("")
)
try {
  await ui.start(join(f.root, "appdata"))
  await ui.named("or enter a path")
  await ui.fill('[aria-label="Repository path"]', f.repo)
  await ui.named("Open")
  await ui.has("Read your changes")
  await ui.startManualReview()
  await ui.named("Code Explain", "[role=tab]")
  await ui.until(
    `!!document.querySelector('nav[aria-label="Snapshot files"] [title="notes.TXT"]')`
  )
  await ui.click('nav[aria-label="Snapshot files"] [title="notes.TXT"]')
  await ui.has("Cache fixture")
  await ui.fill('input[aria-label="Filter files"]', "notes")
  await ui.execute(
    `document.querySelector('[aria-label="Markdown file"]').scrollTop=650;return true`
  )
  const top = await ui.execute<number>(
    `return document.querySelector('[aria-label="Markdown file"]').scrollTop`
  )
  await ui.named("Review", "[role=tab]")
  await ui.named("Code Explain", "[role=tab]")
  await ui.until(
    `document.querySelector('input[aria-label="Filter files"]')?.value==='notes'`
  )
  await ui.until(
    `Math.abs(document.querySelector('[aria-label="Markdown file"]')?.scrollTop-${top})<2`
  )
  await f.write(
    "notes.TXT",
    "# Updated outside ReviewBox\n\nNew captured content\n"
  )
  await ui.has("Updated outside ReviewBox")
  assert(!(await ui.text()).includes("Snapshot content is unavailable"))
  await ui.screenshot("cache-refreshed")
  console.log(
    "Native cache: selection/filter/scroll restored, external edit refreshed without reopening."
  )
} finally {
  await ui.stop()
  await f.cleanup()
}
