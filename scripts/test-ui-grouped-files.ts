import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { NativeUI, fixture } from "../tests/native/ui-driver"

process.env.REVIEWBOX_NATIVE_PORT ??= "14490"
process.env.REVIEWBOX_NATIVE_ARTIFACTS ??= "artifacts/grouped-local-native"
const ui = new NativeUI()
const f = await fixture()
try {
  await mkdir(join(f.repo, "db/migrate"), { recursive: true })
  await f.write("db/schema.rb", "schema\n")
  await f.write("db/migrate/change.rb", "migration\n")
  await ui.start(join(f.root, "appdata"))
  await ui.named("or enter a path")
  await ui.fill('[aria-label="Repository path"]', f.repo)
  await ui.named("Open")
  await ui.has("Read your changes")
  await ui.named("View local changes")
  await ui.click('[aria-label="Review file mode"]')
  await ui.named("Local changes", '[role="option"]')
  await ui.until(`!!document.querySelector('[data-file-group="db"]')`)
  assert.equal(
    await ui.execute(
      `return document.querySelector('[aria-label="Unstaged files"] [data-file-group="db"] ul').children.length`
    ),
    2
  )
  await ui.click('[aria-label="Unstaged files"] [title="db/schema.rb"]')
  await ui.until(
    `!!document.querySelector('[aria-label="Unstaged files"] [title="db/schema.rb"][aria-current="page"]')`
  )
  await ui.named("Tree", '[role="tab"]')
  await ui.until(`!document.querySelector('[data-file-group]')`)
  await ui.named("Grouped", '[role="tab"]')
  await ui.until(`!!document.querySelector('[data-file-group="db"]')`)
  await ui.click('[aria-label="Unstaged files"] [title="db/migrate/change.rb"]')
  await ui.execute(
    `document.querySelector('[aria-label="Unstaged files"] [title="db/schema.rb"]').dispatchEvent(new MouseEvent('click',{bubbles:true,shiftKey:true})); return true`
  )
  await ui.execute(
    `const e=document.querySelector('[aria-label="Unstaged files"] [title="db/schema.rb"]'); e.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,button:2})); return true`
  )
  await ui.until(`!!document.querySelector('[role="menu"]')`)
  console.log(
    await ui.execute(
      `return [...document.querySelectorAll('[role="menuitem"]')].map(e=>e.textContent)`
    )
  )
  await ui.screenshot("grouped-local-menu")
  console.log(
    "Native Local changes: db grouping, selection, Tree/Grouped and context menu passed"
  )
} catch (error) {
  console.log(await ui.text().catch(() => "No view"))
  await ui.screenshot("failure").catch(() => {})
  throw error
} finally {
  await ui.stop()
  await f.cleanup()
}
