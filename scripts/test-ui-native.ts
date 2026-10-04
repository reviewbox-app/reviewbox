import assert from "node:assert/strict"
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
      // Without a tour written by Rev, the review opens on the code.
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
  await scenario("command palette and keyboard navigation", async () => {
    await ui.keys("\uE03D", "k")
    await ui.until("!!document.querySelector('[role=combobox]')")
    await ui.fill('[role="combobox"]', "Switch document")
    await ui.named("Switch document / code", '[role="option"]', false)
    await ui.until("!document.querySelector('[aria-label=\"Code diff\"]')")
    // Reading shortcuts are ignored while a dialog is still closing.
    await ui.until("!document.querySelector('[role=dialog]')")
    await ui.keys("d")
    await ui.until("!!document.querySelector('[aria-label=\"Code diff\"]')")
  })
  await scenario(
    "Code Editor reads files without tours or glossary",
    async () => {
      await ui.named("Code Editor", '[role="tab"]')
      await ui.fill('[aria-label="Filter files"]', "answer.ts")
      await ui.named("answer.ts", '[aria-label="Project files"] button', false)
      await ui.until("!!document.querySelector('.monaco-editor')")
      assert(
        await ui.execute(
          `return ![...document.querySelectorAll('[role=tab]')].some(e=>['Files','Tours','Glossary'].includes(e.textContent.trim()))`
        )
      )
      await ui.screenshot("03-understand")
    }
  )
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
      // Step through the review until the refreshed passage is on screen.
      const refreshed =
        "return [...document.querySelectorAll('.view-lines')].some(e=>e.textContent.includes('44'))"
      for (let i = 0; i < 6 && !(await ui.execute<boolean>(refreshed)); i++) {
        await ui.keys("j")
        await Bun.sleep(600)
      }
      await ui.until(refreshed.replace("return ", ""))
    }
  )
  await scenario(
    "resume reviews and return to the saved reading position",
    async () => {
      await ui.named("Home", '[role="tab"]')
      await ui.named("Resume", "main button")
      await ui.until("!!document.querySelector('[aria-label=\"Review\"]')")
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
