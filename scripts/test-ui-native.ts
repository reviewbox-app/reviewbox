import assert from "node:assert/strict"
import { readdir, readFile, writeFile } from "node:fs/promises"
import { NativeUI, fixture } from "../tests/native/ui-driver"

const f = await fixture()
const ui = new NativeUI()
const passed: string[] = []
async function scenario(name: string, run: () => Promise<void>) {
  console.log(`UI: ${name}`)
  await run()
  passed.push(name)
}
try {
  await ui.start(`${f.root}/appdata`)
  await scenario(
    "open repository and capture local changes through the UI",
    async () => {
      await ui.named("or enter a path")
      await ui.fill('[aria-label="Repository path"]', f.repo)
      await ui.named("Open")
      await ui.has("New review")
      await ui.startManualReview()
      await ui.until("!!document.querySelector('.monaco-editor')")
      await ui.has("src/answer.ts")
      await ui.screenshot("01-review")
    }
  )
  await scenario("human validation and reopening", async () => {
    await ui.named("Validate passage")
    await ui.named("Reopen passage")
    await ui.named("Validate passage")
    await ui.has("Validated by Reviewer")
  })
  await scenario(
    "notes and questions through the rich text editor",
    async () => {
      await ui.named("Notes", '[role="tab"]', false)
      await ui.fill(
        '[contenteditable="true"][role="textbox"]',
        "A persistent review note"
      )
      await ui.named("Add note")
      await ui.has("A persistent review note")
      await ui.named("Question", '[role="radio"]')
      await ui.fill(
        '[contenteditable="true"][role="textbox"]',
        "Why change the answer?"
      )
      await ui.named("Ask question")
      await ui.has("Why change the answer?")
      await ui.screenshot("02-notes")
    }
  )
  await scenario("resolve, reopen and delete annotations", async () => {
    await ui.named("Resolve")
    await ui.named("Reopen")
    await ui.named("Resolve")
    await ui.named("Delete")
    await ui.until(
      "!document.body.innerText.includes('Why change the answer?')"
    )
    await ui.named("Delete note")
    await ui.until(
      "!document.body.innerText.includes('A persistent review note')"
    )
  })
  await scenario("failed note saves preserve the draft for retry", async () => {
    const reviewId = (await readdir(`${f.repo}/.reviewbox/reviews`))[0]
    const path = `${f.repo}/.reviewbox/reviews/${reviewId}/review.json`
    const original = await readFile(path)
    await ui.named("Note", '[role="radio"]')
    await ui.fill(
      '[contenteditable="true"][role="textbox"]',
      "Keep this draft if saving fails"
    )
    await writeFile(path, "<<<<<<< conflicting review\n")
    try {
      await ui.named("Add note")
      await ui.until("!!document.querySelector('[role=alert]')")
      assert.match(
        await ui.execute<string>(
          "return document.querySelector('[contenteditable=true]')?.textContent ?? ''"
        ),
        /Keep this draft/
      )
    } finally {
      await writeFile(path, original)
    }
    await ui.named("Dismiss")
    await ui.named("Add note")
    await ui.has("Keep this draft if saving fails")
  })
  await scenario("create a topic and navigate repeated anchors", async () => {
    await ui.named("Add topic")
    await ui.fill("#topic-title", "Answer behavior")
    await ui.fill("#topic-brief", "Check both staged and unstaged behavior")
    await ui.fill('[aria-label="Step title"]', "Compare the answer")
    await ui.fill(
      '[aria-label="Step explanation"]',
      "The answer changes twice in separate layers."
    )
    await ui.click('[role="dialog"] [role="checkbox"]')
    await ui.named("Add step")
    await ui.fill('[aria-label="Step title"]', "Compare again")
    await ui.fill(
      '[aria-label="Step explanation"]',
      "A second reading goal for the same passage."
    )
    await ui.click('[role="dialog"] [role="checkbox"]')
    await ui.named("Add step")
    await ui.named("Save topic")
    await ui.has("Answer behavior")
    await ui.named("Explanation", '[role="tab"]')
    await ui.named("Next step (J)")
    await ui.has("Step 2 of 2")
    await ui.has("A second reading goal for the same passage.")
    await ui.named("Previous step (K)")
    await ui.has("Step 1 of 2")
  })
  await scenario(
    "test permission refusal and observed successful run",
    async () => {
      await ui.named("Run a test…")
      await ui.named("bun test", '[role="menuitem"]')
      await ui.has("Allow this command once?")
      await ui.named("Deny")
      await ui.has("Denied")
      await ui.named("Run a test…")
      await ui.named("bun test", '[role="menuitem"]')
      await ui.named("Allow once")
      await ui.has("Passed")
    }
  )
  await scenario("command palette and keyboard navigation", async () => {
    await ui.keys("\uE03D", "k")
    await ui.until("!!document.querySelector('[role=combobox]')")
    await ui.fill('[role="combobox"]', "Coverage")
    await ui.named("Coverage and changes outside the tour", '[role="option"]')
    await ui.until("!!document.querySelector('[aria-label=Coverage]')")
    await ui.named("Back to code (Esc)")
  })
  await scenario(
    "glossary creation, aliases and multiple meanings",
    async () => {
      await ui.named("Understand", '[role="tab"]')
      await ui.named("Glossary", '[role="tab"]')
      await ui.fill("#term-name", "answer")
      await ui.fill('[aria-label="Aliases"]', "response")
      await ui.fill('[aria-label="Definition"]', "The exported response value")
      await ui.named("Save meaning")
      await ui.has("The exported response value")
      await ui.named("Add another meaning")
      await ui.fill('[aria-label="Definition"]', "A reply to a question")
      await ui.named("Save meaning")
      await ui.has("A reply to a question")
    }
  )
  await scenario("write an explanation and define one occurrence", async () => {
    await ui.named("Files", '[role="tab"]')
    await ui.fill('[aria-label="Filter files"]', "answer.ts")
    await ui.named("answer.ts", '[aria-label="Snapshot files"] button', false)
    await ui.named("Add a section")
    await ui.fill('[aria-label="Section title"]', "Exported answer")
    await ui.fill(
      '[aria-label="Explanation"]',
      "The answer is a constant response."
    )
    await ui.named("Save section")
    await ui.has("Exported answer")
    await ui.named("Explain a word")
    await ui.fill("#occurrence-word", "constant")
    await ui.fill(
      "#occurrence-description",
      "This binding cannot be reassigned"
    )
    await ui.named("Save for this occurrence")
    await ui.has("Exported answer")
    await ui.hover('button[title="Multiple meanings — choose in glossary"]')
    await ui.has("Ambiguous")
    await ui.has("A reply to a question")
    await ui.hover('button[title="This binding cannot be reassigned"]')
    await ui.has("This binding cannot be reassigned")
    await ui.screenshot("03-understand")
    await ui.named("Glossary", '[role="tab"]')
    await ui.named("Archive")
    await ui.until(
      "!document.querySelector('main')?.textContent.includes('The exported response value')"
    )
    await ui.named("Files", '[role="tab"]')
    await ui.until(
      "!document.querySelector('button[title=\"Multiple meanings — choose in glossary\"]')"
    )
    await ui.element('button[title="This binding cannot be reassigned"]')
  })
  await scenario("create a current-code tour and edit its anchor", async () => {
    await ui.named("Tours", '[role="tab"]')
    await ui.fill('[aria-label="New tour title"]', "Getting started")
    await ui.named("Create tour")
    await ui.has("Getting started")
    await ui.named("Add step")
    await ui.fill('[aria-label="Step title"]', "Read the export")
    await ui.fill('[aria-label="Relative source path"]', "src/answer.ts")
    await ui.fill(
      '[aria-label="Step explanation"]',
      "Start at the answer export"
    )
    await ui.named("Save current anchor")
    await ui.has("Read the export")
    await ui.screenshot("04-tour")
    await ui.named("Mark read")
    await ui.named("Mark unread")
    await ui.named("Edit")
    await ui.fill('[aria-label="Step title"]', "Read the answer export")
    await ui.named("Save current anchor")
    await ui.has("Read the answer export")
    await f.write(
      "src/answer.ts",
      "// moved export\nexport const answer = 43;\n"
    )
    await ui.has("exact passage moved to line 2")
    await f.write("src/answer.ts", "export const answer = 99;\n")
    await ui.has("This anchor changed")
    await ui.named("Repair anchor")
    await ui.fill('[aria-label="First line"]', "1")
    await ui.fill('[aria-label="Last line"]', "1")
    await ui.named("Save current anchor")
    await ui.has("Anchor still valid")
    await f.write("src/answer.ts", "export const answer = 43;\n")
  })
  await scenario(
    "external changes flag the frozen snapshot and refresh explicitly",
    async () => {
      await ui.named("Review", '[role="tab"]')
      await f.write("src/answer.ts", "export const answer = 44;\n")
      await ui.wait(
        async () => (await ui.text()).includes("Refresh snapshot"),
        "external source change",
        45000
      )
      await ui.screenshot("05-changed")
      await ui.named("Refresh snapshot")
      await ui.until("!document.body.innerText.includes('Refresh snapshot')")
      await ui.keys("j")
      await ui.keys("j")
      await ui.until(
        "[...document.querySelectorAll('.view-lines')].some(e=>e.textContent.includes('44'))"
      )
      await ui.named("Review actions")
      await ui.named("Review history", '[role="menuitem"]')
      await ui.screenshot("06-history")
      await ui.keys("\uE00C")
    }
  )
  await scenario(
    "resume reviews and return to the saved reading position",
    async () => {
      await ui.named("Resume", '[role="tab"]')
      await ui.named("Resume", "main button")
      await ui.until("!!document.querySelector('[aria-label=\"Code diff\"]')")
    }
  )
  await scenario("application theme and project settings persist", async () => {
    // Use the palette's settings action to exercise the in-window dialog too.
    await ui.keys("\uE03D", "k")
    await ui.fill('[role="combobox"]', "Settings")
    await ui.named("Settings", '[role="option"]', false)
    await ui.named("Light", '[role="tab"]')
    await ui.until("document.documentElement.classList.contains('light')")
    await ui.named("Dark", '[role="tab"]')
    await ui.named("Project")
    await ui.fill("#project-language", "English")
    await ui.named("Save project settings")
    await ui.has("Saved")
    await ui.keys("\uE00C")
    const settings = await Bun.file(`${f.repo}/.reviewbox/settings.json`).json()
    assert.equal(settings.data.language, "English")
  })
  assert.equal(
    f.git("write-tree"),
    f.index,
    "ReviewBox must not alter the Git index"
  )
  assert.deepEqual(await ui.execute("return window.__uiErrors"), [])
  await Bun.write(
    `${ui.artifacts}/journeys.json`,
    JSON.stringify({ passed }, null, 2)
  )
  console.log(JSON.stringify({ passed }, null, 2))
} catch (error) {
  await ui.screenshot("failure").catch(() => {})
  console.error((await ui.text().catch(() => "No UI")).slice(-14000))
  throw error
} finally {
  await ui.stop()
  await f.cleanup()
}
