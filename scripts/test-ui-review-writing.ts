import assert from "node:assert/strict"
import { join } from "node:path"
import { NativeUI, fixture } from "../tests/native/ui-driver"

const f = await fixture()
const ui = new NativeUI()
try {
  await ui.start(join(f.root, "writing-data"))
  await ui.named("Settings")
  await ui.wait(
    async () =>
      (await ui.request<string[]>(ui.route("/window/handles"))).includes(
        "settings"
      ),
    "settings window"
  )
  await ui.request(ui.route("/window"), { handle: "settings" })
  await ui.named("Reading", "nav button")
  await ui.until(
    `!![...document.querySelectorAll('label')].find(e=>e.textContent.trim()==='Essential')?.querySelector('[aria-checked="true"]')`,
    "default Essential"
  )
  await ui.named("Custom", "label")
  await ui.until(
    `!!document.querySelector('textarea[aria-label="Custom review writing instructions"]')`
  )
  assert(
    await ui.execute(
      `return [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Save writing preferences').disabled`
    )
  )
  await ui.fill(
    'textarea[aria-label="Custom review writing instructions"]',
    "Explain risks and user-visible behavior in French."
  )
  await ui.named("Save writing preferences")
  await ui.until(
    `document.body.textContent.includes('Saved for the next preparation.')`
  )
  await ui.named("General", "nav button")
  await ui.named("Reading", "nav button")
  await ui.until(
    `document.querySelector('textarea')?.value === 'Explain risks and user-visible behavior in French.'`,
    "saved custom profile"
  )
  await ui.screenshot("review-writing-custom")
  console.log(
    "Native writing settings: Essential default, required Custom instructions and persisted reload passed"
  )
} catch (error) {
  console.error(await ui.text().catch(() => ""))
  throw error
} finally {
  await ui.stop()
  await f.cleanup()
}
