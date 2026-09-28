import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { NativeUI, fixture } from "../tests/native/ui-driver"
import { createPreparationHarness } from "../tests/native/preparation-fixture"

const f = await fixture()
const ui = new NativeUI()
const harness = await createPreparationHarness(f.root, false, 11, true)
await writeFile(harness.mode, "done")
await writeFile(join(f.repo, "binary.dat"), Buffer.from([0, 1, 255, 0]))
async function level(name: string) {
  await ui.click('[aria-label="Reading level"]')
  await ui.named(name, '[role="option"]')
  await ui.until(
    `document.querySelector('[aria-label="Reading level"]').textContent.includes(${JSON.stringify(name)})`
  )
}
async function representation(name: string) {
  // The selected Code tab opens its representation menu on a second click.
  const tab = '[role="tab"][aria-label="Code"]'
  if (
    !(await ui.execute(
      `return document.querySelector('${tab}').getAttribute("aria-selected")==="true"`
    ))
  )
    await ui.click(tab)
  await ui.click(tab)
  await ui.named(name, '[role="menuitemradio"]')
}
async function theme(name: string) {
  await ui.request(ui.route("/window"), { handle: "settings" })
  await ui.named("General", "nav button")
  await ui.named(name, '[role="tab"]')
  await ui.request(ui.route("/window"), { handle: "main" })
  await ui.until(
    `document.documentElement.classList.contains(${JSON.stringify(name.toLowerCase())})`
  )
}
try {
  await ui.start(join(f.root, "appdata"))
  // macOS suspends animation frames in a covered WebView. Keep this interaction
  // suite rendering while occluded; animation timing is not under test here.
  await ui.execute(`
    window.BASE_UI_ANIMATIONS_DISABLED=true;
    const frame=window.requestAnimationFrame.bind(window),cancel=window.cancelAnimationFrame.bind(window);
    window.requestAnimationFrame=callback=>document.hidden?-setTimeout(()=>callback(performance.now()),16):frame(callback);
    window.cancelAnimationFrame=id=>id<0?clearTimeout(-id):cancel(id);
    return true;
  `)
  await ui.named("Settings")
  await ui.wait(
    async () =>
      (await ui.request<string[]>(ui.route("/window/handles"))).includes(
        "settings"
      ),
    "settings"
  )
  await ui.request(ui.route("/window"), { handle: "settings" })
  await ui.named("Rev", "nav button")
  await ui.setHarnessExecutable("codex", harness.executable)
  await ui.setDefaultHarness("codex")
  await ui.request(ui.route("/window"), { handle: "main" })
  await ui.named("or enter a path")
  await ui.fill('[aria-label="Repository path"]', f.repo)
  await ui.named("Open")
  await ui.reviewScope()
  await ui.nextReviewStep()
  await ui.named("With Rev", "label", false)
  await ui.named("Start review", "[role=dialog] footer button")
  await ui.wait(
    async () => {
      const text = await ui.text()
      const error = await ui.execute<string>(
        'return document.querySelector("[data-testid=preparing-review] [role=alert]")?.textContent ?? ""'
      )
      assert(!error, error)
      return text.includes("Your review is ready")
    },
    "prepared reader fixture",
    120000
  )
  await ui.until(
    '[...document.querySelectorAll("button")].find(e=>e.textContent.trim()==="Start review")?.disabled === false'
  )
  await ui.named("Start review")
  await ui.has("Step 1 of 11")
  await ui.named("Contents")
  assert.equal(
    await ui.execute(
      'return document.querySelectorAll("[aria-label=\\"Review steps\\"] > li").length'
    ),
    11
  )
  assert(!(await ui.text()).includes("Not explained by Rev"))
  await ui.keys("\uE00C")

  await level("Beginner")
  assert.equal(
    await ui.execute(
      'return !!document.querySelector("[aria-label=\\"Code diff\\"], [aria-label=Files], [role=menu][aria-label=\\"Code representation\\"]")'
    ),
    false
  )
  await ui.has("The remembered value changes")
  for (const name of ["Dark", "Light"]) {
    await theme(name)
    for (const width of [1440, 800]) {
      await ui.resize(width, 900)
      await ui.execute(
        'const e=document.querySelector("[aria-label=\\"Review document\\"]");e.scrollTop=180;return true'
      )
      const glass = await ui.execute<{
        blur: string
        overlay: boolean
        scrolledUnder: boolean
      }>(
        'const m=document.querySelector("main[aria-label=Review]"),h=m.querySelector(":scope > header"),s=m.querySelector("[aria-label=\\"Review document\\"]"),t=s.querySelector("article h1");return {blur:getComputedStyle(h).backdropFilter,overlay:s.getBoundingClientRect().top<h.getBoundingClientRect().bottom,scrolledUnder:t.getBoundingClientRect().top<h.getBoundingClientRect().bottom}'
      )
      assert(
        glass.blur.includes("14px") && glass.overlay && glass.scrolledUnder,
        JSON.stringify(glass)
      )
      assert.deepEqual((await ui.layout()).overflow, [])
      await ui.screenshot(`reader-document-${name.toLowerCase()}-${width}`)
    }
  }
  await ui.resize(1440, 900)
  await level("Intermediate")
  await ui.execute(
    'document.querySelector("[aria-label=\\"Review document\\"]").scrollTop=0;return true'
  )
  await ui.named("value", "main[aria-label=Review] article button")
  await ui.until('!!document.querySelector("[role=dialog]")')
  await ui.has("Read the captured value, step 1")
  assert(
    !(
      await ui.execute<string>(
        'return document.querySelector("[role=dialog]").textContent'
      )
    ).includes("export const")
  )
  await ui.named("Open alongside the document", "[role=dialog] button")
  await ui.until(
    '!!document.querySelector("[aria-label=\\"Code diff\\"] .monaco-editor")'
  )
  await ui.has("Step 1 of 11")
  await ui.named("Close pinned reference")
  await ui.named("Validate step and continue")
  await ui.has("Step 2 of 11")
  assert(
    await ui.execute(
      'return [...document.querySelectorAll("button")].some(e=>e.textContent.trim()==="Validate step and continue")'
    ),
    "overlapping step remains unvalidated"
  )
  await ui.execute(
    'window.dispatchEvent(new KeyboardEvent("keydown",{key:"v",repeat:true,bubbles:true}));return true'
  )
  await ui.has("Step 2 of 11")
  await ui.execute(
    'const button=[...document.querySelectorAll("button")].find(e=>e.textContent.trim()==="Validate step and continue");button.dispatchEvent(new MouseEvent("click",{bubbles:true,detail:2}));return true'
  )
  await ui.has("Step 2 of 11")

  await level("Developer")
  await ui.named("Code", "[role=tab]")
  assert(
    (await ui.execute<string>(
      `return document.querySelector('[role="tab"][aria-label="Code"]').textContent.trim()`
    )) === "Code",
    "Developer defaults to captured source"
  )
  await representation("Code")
  await ui.until(
    'document.querySelector("[aria-label=\\"Code diff\\"] .view-lines")?.textContent.includes("export")'
  )
  await representation("Pseudo-code")
  await ui.until(
    'document.querySelector("[aria-label=\\"Code diff\\"] .view-lines")?.textContent.replaceAll(String.fromCharCode(160), " ").includes("Read the captured value")'
  )
  for (const name of ["Dark", "Light"]) {
    await theme(name)
    for (const width of [1440, 800]) {
      await ui.resize(width, 900)
      await ui.execute(
        'document.querySelector(".monaco-diff-editor .modified .monaco-scrollable-element").dispatchEvent(new WheelEvent("wheel",{deltaY:220,bubbles:true,cancelable:true}));return true'
      )
      assert.deepEqual((await ui.layout()).overflow, [])
      await ui.screenshot(`reader-code-${name.toLowerCase()}-${width}`)
    }
  }
  await ui.resize(1440, 900)
  await ui.named("Files")
  assert.equal(
    await ui.execute(
      'return document.querySelectorAll("[aria-label=\\"Review files\\"] [aria-expanded=true]").length'
    ),
    0,
    "folders start closed"
  )
  // Open every folder, level by level, to count the files of the tree.
  while (
    await ui.execute(
      'const folders=[...document.querySelectorAll("[aria-label=\\"Review files\\"] [aria-expanded=false]")];folders.forEach(e=>e.click());return folders.length>0'
    )
  )
    await Bun.sleep(100)
  assert.equal(
    await ui.execute(
      'return document.querySelectorAll("[aria-label=\\"Review files\\"] button[title]").length'
    ),
    4,
    "one row per path despite staged and unstaged"
  )
  await ui.resize(800, 900)
  assert.deepEqual((await ui.layout()).overflow, [])
  await ui.screenshot("reader-both-panels-800")
  await ui.resize(1440, 900)
  await ui.named("answer.ts", '[aria-label="Review files"] button', false)
  await ui.has("Validate file and continue")
  assert.equal(
    await ui.execute(
      'return !!document.querySelector("aside[aria-label=Explanation]")'
    ),
    false,
    "manual file navigation never generates or displays a file document"
  )
  assert.equal(
    await ui.execute(
      'return document.querySelectorAll("[aria-label=\\"File layers\\"] button").length'
    ),
    2
  )
  await ui.named("unstaged", '[aria-label="File layers"] button')
  await level("Intermediate")
  await ui.named("binary.dat", '[aria-label="Review files"] button', false)
  assert(
    await ui.execute(
      'return [...document.querySelectorAll("button")].find(e=>e.textContent.trim()==="Validate file and continue").disabled'
    ),
    "untranslated intermediate file cannot be validated"
  )
  await level("Developer")
  await representation("Code")
  assert(
    !(await ui.execute(
      'return [...document.querySelectorAll("button")].find(e=>e.textContent.trim()==="Validate file and continue").disabled'
    )),
    "developer may review binary metadata"
  )
  const selectedFile = await ui.execute<string>(
    'return document.querySelector("[aria-label=\\"Review files\\"] [aria-current=page]").getAttribute("title")'
  )
  await ui.named("Validate file and continue")
  await ui.until(
    `document.querySelector('[aria-label="Review files"] [aria-current="page"]').getAttribute('title') !== ${JSON.stringify(selectedFile)}`
  )
  await ui.named("Contents")
  await ui.named("The other value", '[aria-label="Review steps"] button', false)
  await ui.has("Step 2 of 11")
  for (let step = 2; step <= 11; step++) {
    await ui.has(`Step ${step} of 11`)
    await ui.named("Validate step and continue")
  }
  await ui.has("Review complete")
  await ui.has("11 of 11 steps validated")
  await ui.named("Home", "main[aria-label=Review] button")
  await ui.has("Complete")

  await ui.named("Review", '[role="tab"]')
  await ui.until('!!document.querySelector("main[aria-label=Review] > footer")')
  await f.write("src/answer.ts", "export const answer = 99;\n")
  await ui.execute("window.dispatchEvent(new Event('focus'));return true")
  await ui.wait(
    async () => (await ui.text()).includes("Refresh snapshot"),
    "external source change",
    45000
  )
  await ui.named("Refresh snapshot")
  await ui.until("!document.body.innerText.includes('Refresh snapshot')")
  await ui.until('!document.querySelector("main[aria-label=Review] > footer")')
  await ui.named("Code", "[role=tab]")
  await ui.screenshot("reader-refreshed-without-footer")

  await ui.keys("\uE03D", "n")
  await ui.startManualReview()
  await ui.until('!document.querySelector("main[aria-label=Review] > footer")')
  assert(
    (
      await ui.execute<string>(
        'return document.querySelector("[aria-label=\\"Reading level\\"]").textContent'
      )
    ).includes("Developer")
  )
  await ui.named("Code", "[role=tab]")
  assert.equal(
    await ui.execute(
      'return !!document.querySelector("aside[aria-label=Explanation]")'
    ),
    false,
    "files without documents hide the requested panel"
  )
  assert.equal(
    await ui.execute(
      'return document.querySelector("button[aria-label=Explanation]").getAttribute("aria-pressed")'
    ),
    "true",
    "automatic hide keeps the user preference"
  )
  await level("Intermediate")
  assert(
    await ui.execute(
      'return !document.querySelector("main[aria-label=Review] > footer")'
    )
  )
  await level("Beginner")
  await ui.has("Explore the captured file")
  assert(
    await ui.execute(
      'return !document.querySelector("main[aria-label=Review] > footer")'
    ),
    "reviews without steps have no decision footer at any reading level"
  )
  await ui.request(ui.route("/window"), { handle: "settings" })
  await ui.named("Reading", "nav button")
  await ui.until(
    `document.querySelector('[aria-label="Reading level"] [role="radio"][aria-checked="true"]')?.closest("label").textContent.includes("Intermediate")`
  )
  await ui.named("Developer", '[aria-label="Reading level"] label', false)
  await ui.until(
    `document.querySelector('[aria-label="Reading level"] [role="radio"][aria-checked="true"]')?.closest("label").textContent.includes("Developer")`
  )
  await ui.named("Intermediate", '[aria-label="Reading level"] label', false)
  await ui.until(
    `document.querySelector('[aria-label="Reading level"] [role="radio"][aria-checked="true"]')?.closest("label").textContent.includes("Intermediate")`
  )
  await ui.execute(
    `document.querySelector('[aria-label="Ask when starting a review"]').focus();return true`
  )
  await ui.keys(" ")
  await ui.until(
    `document.querySelector('[aria-label="Ask when starting a review"]').getAttribute("aria-checked") === "true"`
  )
  await ui.request(ui.route("/window"), { handle: "main" })
  await ui.keys("\uE03D", "n")
  await ui.reviewScope()
  await ui.nextReviewStep()
  await ui.named("With Rev", "label", false)
  await ui.until(
    `document.querySelector('[role="dialog"] [aria-label="Reading level"] [role="radio"][aria-checked="true"]')?.closest("label").textContent.includes("Intermediate")`
  )
  await ui.named(
    "Beginner",
    '[role="dialog"] [aria-label="Reading level"] label',
    false
  )
  await ui.until(
    `document.querySelector('[role="dialog"] [aria-label="Reading level"] [role="radio"][aria-checked="true"]')?.closest("label").textContent.includes("Beginner")`
  )
  await ui.named("Close new review")
  assert.deepEqual(await ui.execute("return window.__uiErrors"), [])
  assert.equal(f.git("write-tree"), f.index)
  console.log(
    "Native reader: eleven guided steps, three levels, source references, independent file decisions, atomic validation and next, summary, unavailable pseudocode, glass surfaces passed."
  )
} catch (error) {
  console.error(await ui.text().catch(() => "No UI"))
  await ui.screenshot("reader-failure").catch(() => {})
  throw error
} finally {
  await ui.stop()
  await f.cleanup()
}
