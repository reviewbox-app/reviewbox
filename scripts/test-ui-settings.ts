import assert from "node:assert/strict"
import { NativeUI, fixture } from "../tests/native/ui-driver"
const f = await fixture()
const ui = new NativeUI()
try {
  await ui.start(`${f.root}/appdata`)
  await ui.named("or enter a path")
  await ui.fill('[aria-label="Repository path"]', f.repo)
  await ui.named("Open")
  await ui.startManualReview()
  await ui.until("!!document.querySelector('.monaco-editor')")
  await ui.named("Settings")
  await ui.wait(
    async () =>
      (await ui.request<string[]>(ui.route("/window/handles"))).includes(
        "settings"
      ),
    "native settings window"
  )
  await ui.request(ui.route("/window"), { handle: "settings" })
  await ui.has("General")
  await ui.named("Light", "[role=tab]")
  await ui.until("document.documentElement.classList.contains('light')")
  for (const name of [
    "Rev",
    "Permissions",
    "Context sent",
    "Integrations",
    "Languages",
    "Storage",
    "Shortcuts",
    "Project",
  ]) {
    await ui.named(name, "nav button")
    await ui.resize(800, 700)
    const layout = await ui.layout()
    assert.deepEqual(layout.overflow, [], `Settings: ${name}`)
    assert.deepEqual(layout.clipped, [], `Settings: ${name}`)
  }
  await ui.fill("#project-language", "English")
  await ui.named("Save project settings")
  await ui.has("Saved")
  await ui.screenshot("settings-window")
  await ui.request(ui.route("/window"), undefined, "DELETE")
  await ui.request(ui.route("/window"), { handle: "main" })
  await ui.named("Settings")
  await ui.wait(
    async () =>
      (await ui.request<string[]>(ui.route("/window/handles"))).includes(
        "settings"
      ),
    "reopened settings"
  )
  await ui.request(ui.route("/window"), { handle: "settings" })
  await ui.named("Project", "nav button")
  await ui.until(
    "document.querySelector('#project-language')?.value === 'English'"
  )
  assert.equal(
    (await Bun.file(`${f.repo}/.reviewbox/settings.json`).json()).data.language,
    "English"
  )
  console.log(
    "Native settings window, all sections, theme and project persistence passed"
  )
} catch (error) {
  await ui.screenshot("settings-failure").catch(() => {})
  console.error(await ui.text().catch(() => ""))
  throw error
} finally {
  await ui.stop()
  await f.cleanup()
}
