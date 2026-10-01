import assert from "node:assert/strict"
import { join } from "node:path"
import { NativeUI, fixture } from "../tests/native/ui-driver"
import {
  documentBefore,
  documentAfter,
} from "../src/features/development/fixtures/documentDiff.fixture"

process.env.REVIEWBOX_NATIVE_PORT ??= "14467"
process.env.REVIEWBOX_NATIVE_ARTIFACTS ??= "artifacts/validation/document-diff"
const f = await fixture()
const ui = new NativeUI()
for (const path of ["README.md", "LICENSE", "notes.TXT", "CMakeLists.txt"])
  await f.write(path, documentBefore)
f.git("add", "README.md", "LICENSE", "notes.TXT", "CMakeLists.txt")
f.git(
  "commit",
  "--only",
  "README.md",
  "LICENSE",
  "notes.TXT",
  "CMakeLists.txt",
  "-m",
  "Captured document fixture"
)
for (const path of ["README.md", "LICENSE", "notes.TXT", "CMakeLists.txt"])
  await f.write(path, documentAfter)
const region = '[aria-label="Markdown file diff"]'
const toggle = '[aria-label="Markdown preview"]'
let originalTheme: string | null = null
async function openFile(name: string) {
  await ui.keys("\uE03D", "k")
  await ui.fill('[role="combobox"]', name)
  await ui.named(name, '[role="option"]', false)
  await ui.until(
    `document.querySelector('[aria-label="Code diff"] header')?.textContent.includes(${JSON.stringify(name)})`
  )
}
async function preview() {
  await ui.until(
    `!!document.querySelector('${region} h1')`,
    "rendered captured Markdown"
  )
}
async function theme(name: "Dark" | "Light" | "System") {
  await ui.named("Settings")
  await ui.wait(
    async () =>
      (await ui.request<string[]>(ui.route("/window/handles"))).includes(
        "settings"
      ),
    "settings"
  )
  await ui.request(ui.route("/window"), { handle: "settings" })
  await ui.named("General", "nav button")
  await ui.named(name, '[role="tab"]')
  await ui.request(ui.route("/window"), { handle: "main" })
  if (name !== "System")
    await ui.until(
      `document.documentElement.classList.contains('${name.toLowerCase()}')`
    )
}
try {
  await ui.start(join(f.root, "appdata"))
  originalTheme = await ui.execute("return localStorage.getItem('theme')")
  await ui.execute(`window.BASE_UI_ANIMATIONS_DISABLED=true;
    const frame=window.requestAnimationFrame.bind(window),cancel=window.cancelAnimationFrame.bind(window);
    window.requestAnimationFrame=callback=>document.hidden?-setTimeout(()=>callback(performance.now()),16):frame(callback);
    window.cancelAnimationFrame=id=>id<0?clearTimeout(-id):cancel(id);return true;`)
  await ui.named("or enter a path")
  await ui.fill('[aria-label="Repository path"]', f.repo)
  await ui.named("Open")
  await ui.startManualReview()
  await openFile("README.md")
  await preview()
  assert.equal(
    await ui.execute(
      `return document.querySelector('${toggle}').getAttribute('aria-pressed')`
    ),
    "true"
  )
  assert.equal(
    await ui.execute(
      `return document.querySelectorAll('${region} table').length`
    ),
    2
  )
  assert.deepEqual(
    await ui.execute(
      `return [...document.querySelectorAll('${region} table mark')].map(mark=>mark.textContent)`
    ),
    ["3", "Private application data", "4", "Local only"],
    "changed words share single spaces and stay inside their table cells"
  )
  assert.deepEqual(
    await ui.execute(
      `return [...document.querySelectorAll('${region} ul mark')].map(mark=>mark.textContent)`
    ),
    ["old value", "fresh content"]
  )
  assert(
    await ui.execute(
      `const added=[...document.querySelectorAll('${region} [data-change=added]')].find(block=>block.textContent.includes('A newly added paragraph needs no inline highlight.'));return !!added && !added.querySelector('mark')`
    ),
    "a new block only uses its green background"
  )
  assert.equal(
    await ui.execute(
      `return document.querySelectorAll('${region} ul ul').length`
    ),
    2
  )
  assert(
    await ui.execute(
      `return document.querySelector('${region}').textContent.includes('End of captured document.')`
    )
  )
  assert.equal(
    await ui.execute(
      `return document.querySelectorAll('[aria-label="Display options"]').length`
    ),
    0
  )
  const cursor = await ui.execute<string>(
    `return document.querySelector('main[aria-label="Review"]')?.textContent.match(/File \\d+ of \\d+/)?.[0]`
  )
  assert(cursor, "the current file scope is visible")
  for (const name of ["Light", "Dark"] as const) {
    await theme(name)
    for (const layout of ["Unified", "Split"]) {
      await ui.named(layout, '[aria-label="Code diff"] [role="tab"]')
      await preview()
      const width = await ui.execute<number>(
        "return document.querySelector('.document-diff-row').getBoundingClientRect().width"
      )
      assert(
        width <= (layout === "Split" ? 1440 : 720),
        "document columns keep the review reader width"
      )
      assert.equal(
        await ui.execute(
          `return document.querySelectorAll('${region} h1').length`
        ),
        layout === "Split" ? 2 : 1
      )
      if (layout === "Split")
        assert(
          await ui.execute(
            `const row=document.querySelector('.document-diff-row');return row.children[0].getBoundingClientRect().top === row.children[1].getBoundingClientRect().top`
          )
        )
      const colors = await ui.execute<{ block: string; mark: string }>(
        `const block=document.querySelector('${region} [data-change=added]');return {block:getComputedStyle(block).backgroundColor,mark:getComputedStyle(block.querySelector('mark')).backgroundColor}`
      )
      assert.notEqual(colors.block, colors.mark)
      await ui.screenshot(
        `markdown-${name.toLowerCase()}-${layout.toLowerCase()}`
      )
    }
  }
  await ui.named("Unified", '[aria-label="Code diff"] [role="tab"]')
  await preview()
  await ui.named("Find in file")
  await ui.fill('[aria-label="Find in document"]', "Needle outcome")
  await ui.until(
    `document.querySelector('[role=search] [role=status]')?.textContent === '1 / 1'`,
    "rendered search"
  )
  await ui.named("Close document search")
  const scroll = await ui.execute<number>(
    `return document.querySelector('${region}').scrollTop`
  )
  await Bun.sleep(3500)
  assert.equal(
    await ui.execute(`return document.querySelector('${region}').scrollTop`),
    scroll,
    "ordinary refresh preserves scroll"
  )
  await ui.execute(`document.querySelector('${toggle}').focus();return true`)
  assert.equal(
    await ui.execute(
      "return document.activeElement.getAttribute('aria-label')"
    ),
    "Markdown preview",
    "keyboard toggle focus"
  )
  // wdio 1.4 sends untrusted key events without the browser's default button
  // activation. Playwright covers Enter/Space; native covers focus and activation.
  await ui.named("Markdown preview")
  await ui.until(
    `document.querySelector('${toggle}')?.getAttribute('aria-pressed') === 'false'`
  )
  await ui.until(
    `document.querySelector('.modified .view-lines:not(.line-delete)')?.textContent.includes('Needle')`,
    "same passage in source"
  )
  assert.equal(
    await ui.execute(
      "return document.querySelectorAll('.diff-hidden-lines').length"
    ),
    0
  )
  await ui.named("Markdown preview")
  await preview()
  assert(
    Math.abs(
      (await ui.execute<number>(
        `return document.querySelector('${region}').scrollTop`
      )) - scroll
    ) < 120,
    "same passage after returning to Markdown"
  )
  await ui.named("Markdown preview")
  await openFile("LICENSE")
  await preview()
  await openFile("notes.TXT")
  await preview()
  await openFile("CMakeLists.txt")
  assert.equal(
    await ui.execute(`return document.querySelectorAll('${toggle}').length`),
    0
  )
  await openFile("README.md")
  await ui.until(
    `document.querySelector('${toggle}')?.getAttribute('aria-pressed') === 'false'`,
    "per-file code preference"
  )
  assert.equal(
    await ui.execute(
      `return document.querySelector('main[aria-label="Review"]')?.textContent.match(/File \\d+ of \\d+/)?.[0]`
    ),
    cursor
  )
  assert.deepEqual(await ui.execute("return window.__uiErrors"), [])
  console.log(
    "Native Markdown diff: centered preview, focusable toggle, Unified/Split, word changes, complete captures, rendered search, both themes, session positions and preserved file scope passed."
  )
} catch (error) {
  console.error(await ui.text().catch(() => ""))
  console.error(await ui.execute("return window.__uiErrors").catch(() => []))
  await ui.screenshot("failure").catch(() => {})
  throw error
} finally {
  if (ui.session)
    await theme(
      originalTheme === "light"
        ? "Light"
        : originalTheme === "dark"
          ? "Dark"
          : "System"
    ).catch(() => {})
  await ui.stop()
  await f.cleanup()
}
