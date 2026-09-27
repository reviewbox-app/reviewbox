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
  await ui.named("Notes", '[role="tab"]', false)
  await check("notes")
  await ui.named("Ask Rev", '[role="tab"]')
  await check("ask-rev")
  await ui.named("Explanation", '[role="tab"]')
  await ui.named("Add topic")
  await ui.fill(
    "#topic-title",
    "VeryLongUnbrokenTopicTitleThatMustWrapWithinTheReadingSidebarRatherThanOverflow"
  )
  await ui.fill(
    '[aria-label="Step title"]',
    "VeryLongUnbrokenStepTitleThatMustRemainReadableWithoutHorizontalScrolling"
  )
  await ui.fill(
    '[aria-label="Step explanation"]',
    "SomeVeryLongUnbrokenTechnicalIdentifierThatMustWrapCorrectlyWithoutGrowingTheInspector"
  )
  await ui.click('[role="dialog"] [role="checkbox"]')
  await ui.named("Add step")
  await ui.named("Save topic")
  await ui.named(
    "VeryLongUnbrokenTopicTitleThatMustWrapWithinTheReadingSidebarRatherThanOverflow",
    '[aria-label="Reading path"] button',
    false
  )
  await check("topics")
  await ui.named("Understand", '[role="tab"]')
  await check("understand")
  await ui.named("Glossary", '[role="tab"]')
  await check("glossary")
  await ui.named("Tours", '[role="tab"]')
  await ui.fill(
    '[aria-label="New tour title"]',
    "ExtremelyLongUnbrokenTourTitleThatMustWrapWithinTheInspectorWithoutScrolling"
  )
  await ui.named("Create tour")
  await ui.has("0 steps · 0 read")
  await check("tours")
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
