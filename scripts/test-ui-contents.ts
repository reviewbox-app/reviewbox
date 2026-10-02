import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { NativeUI, fixture } from "../tests/native/ui-driver"
import { createPreparationHarness } from "../tests/native/preparation-fixture"

process.env.REVIEWBOX_NATIVE_PORT ??= "14469"
process.env.REVIEWBOX_NATIVE_ARTIFACTS ??=
  "artifacts/validation/document-contents"
const widthKey = "reviewbox.panel-width.--review-steps-width"
let savedWidth: string | null = null
const f = await fixture()
const ui = new NativeUI()
// Put both step targets in the middle of a genuinely scrollable captured tree.
const treeFiles = ["a-fixture", "z-fixture"].flatMap((prefix) =>
  Array.from(
    { length: 25 },
    (_, index) => `src/${prefix}-${String(index).padStart(2, "0")}.ts`
  )
)
for (const path of treeFiles) await f.write(path, "export const value = 0;\n")
f.git("add", ...treeFiles)
f.git("commit", "--only", ...treeFiles, "-m", "Scrollable review tree")
for (const path of treeFiles) await f.write(path, "export const value = 1;\n")
const harness = await createPreparationHarness(f.root, false, 11)
await writeFile(harness.mode, "done")
const title =
  "The new amount with **important context** and `values` that extend well beyond the navigation panel width"
await writeFile(
  harness.executable,
  (await readFile(harness.executable, "utf8")).replace(
    "'The new amount'",
    JSON.stringify(title)
  )
)
const panel = 'aside[aria-label="Review contents"]'
const resize = '[role="separator"][aria-label="Resize review steps"]'
try {
  await ui.start(join(f.root, "appdata"))
  savedWidth = await ui.execute(
    "const value=localStorage.getItem(arguments[0]);localStorage.removeItem(arguments[0]);return value",
    [widthKey]
  )
  // macOS suspends animation frames in a covered WebView. Keep this interaction
  // suite rendering while occluded; animation timing is not under test here.
  await ui.execute(`
    window.BASE_UI_ANIMATIONS_DISABLED=true;
    const style=document.createElement('style');
    style.textContent='[data-resize-workspace],aside[aria-label="Review contents"]{transition:none!important}';
    document.head.append(style);
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
  await ui.resize(1440, 900)
  await ui.until(
    `document.querySelector('${panel}').getBoundingClientRect().width >= 279`
  )
  assert(
    await ui.execute(
      `return !document.querySelector('main[aria-label="Review"]').contains(document.querySelector('${panel}')) && !document.querySelector('button[aria-label="Contents"]')`
    )
  )
  assert.equal(
    await ui.execute(`return document.querySelectorAll('${panel} li').length`),
    11
  )
  const list = `${panel} [aria-label="Review steps"]`
  assert.equal(
    await ui.execute(
      `return getComputedStyle(document.querySelector(arguments[0])).maskImage`,
      [list]
    ),
    "none",
    "short list has no mask"
  )
  await ui.execute(
    `const el=document.querySelector(arguments[0]);el.style.maxHeight='160px';el.scrollTop=0;return true`,
    [list]
  )
  await ui.until(
    `getComputedStyle(document.querySelector('${list}')).maskImage !== 'none'`
  )
  const topMask = await ui.execute<string>(
    `return getComputedStyle(document.querySelector(arguments[0])).maskImage`,
    [list]
  )
  assert(topMask.includes("0px") && topMask.includes("16px"), topMask)
  await ui.execute(
    `document.querySelector(arguments[0]).scrollTop=60;return true`,
    [list]
  )
  await ui.until(
    `getComputedStyle(document.querySelector('${list}')).maskImage !== ${JSON.stringify(topMask)}`
  )
  const middleMask = await ui.execute<string>(
    `return getComputedStyle(document.querySelector(arguments[0])).maskImage`,
    [list]
  )
  assert.equal(
    middleMask.match(/16px/g)?.length,
    2,
    "both edges fade in the middle"
  )
  await ui.screenshot("contents-scroll-mask")
  await ui.execute(
    `const el=document.querySelector(arguments[0]);el.scrollTop=el.scrollHeight;return true`,
    [list]
  )
  await ui.until(
    `getComputedStyle(document.querySelector('${list}')).maskImage !== ${JSON.stringify(middleMask)}`
  )
  const bottomMask = await ui.execute<string>(
    `return getComputedStyle(document.querySelector(arguments[0])).maskImage`,
    [list]
  )
  assert(
    bottomMask.includes("100%") &&
      !bottomMask.includes("calc(") &&
      bottomMask.includes("16px") &&
      bottomMask !== topMask,
    bottomMask
  )
  await ui.execute(
    `const el=document.querySelector(arguments[0]);el.style.maxHeight='';el.scrollTop=0;return true`,
    [list]
  )
  await ui.until(
    `getComputedStyle(document.querySelector('${list}')).maskImage === 'none'`
  )
  const typography = await ui.execute<{
    ellipse: string
    nowrap: string
    clipped: boolean
    bold: boolean
  }>(
    `const el=document.querySelector('${panel} li .truncate'),s=getComputedStyle(el);return {ellipse:s.textOverflow,nowrap:s.whiteSpace,clipped:el.scrollWidth>el.clientWidth,bold:!!el.querySelector('strong')}`
  )
  assert.deepEqual(typography, {
    ellipse: "ellipsis",
    nowrap: "nowrap",
    clipped: true,
    bold: true,
  })
  await ui.hover(`${panel} li button`)
  await ui.until(
    `!!document.querySelector('[data-slot="tooltip-content"][data-side="right"]')`
  )
  await ui.hover('main[aria-label="Review"] header')
  // Keyboard focus exposes the same complete title as hovering.
  await ui.execute(
    `document.querySelector('${panel} li button').focus();return true`
  )
  await ui.until(
    `!!document.querySelector('[data-slot="tooltip-content"][data-side="right"]')`
  )
  assert(
    (
      await ui.execute<string>(
        `return document.querySelector('[data-slot="tooltip-content"]').textContent`
      )
    ).includes("extend well beyond")
  )
  await ui.screenshot("steps-tooltip")
  await ui.execute(
    `document.activeElement.blur();window.__document=document.querySelector('[aria-label="Review document"]');const el=document.querySelector('${resize}');el.focus();el.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));return true`
  )
  await ui.until(
    `Math.abs(document.querySelector('${panel}').getBoundingClientRect().width-290)<1`
  )
  await ui.named("Steps")
  await ui.until(
    `document.querySelector('${panel}').getBoundingClientRect().width===0`
  )
  await ui.named("Contents")
  await ui.element('[data-slot="popover-content"] [aria-label="Review steps"]')
  assert.equal(
    await ui.execute(
      `return document.querySelector('${panel}').getBoundingClientRect().width`
    ),
    0,
    "Contents keeps the sidebar closed"
  )
  await ui.keys("\uE00C")
  await ui.named("Steps")
  await ui.until(
    `Math.abs(document.querySelector('${panel}').getBoundingClientRect().width-290)<1`
  )
  assert(
    await ui.execute(
      `return window.__document===document.querySelector('[aria-label="Review document"]')`
    ),
    "document stays mounted"
  )
  await ui.named("The other value", `${panel} button`, false)
  await ui.has("Step 2 of 11")
  await ui.named("Code", '[role="tab"]')
  await ui.named("Contents")
  await ui.named("Behavior 3", '[data-slot="popover-content"] button', false)
  await ui.has("Step 3 of 11")
  await ui.until(
    'document.querySelector(\'aside[aria-label="Review files"]\')?.getAttribute("aria-hidden") === "false"',
    "Code opens the file tree by default"
  )
  const otherFile =
    'nav[aria-label="Review files"] button[title="src/other.ts"]'
  const selectedFile = () =>
    ui.execute<string | null>(
      'return document.querySelector(\'nav[aria-label="Review files"] button[aria-current="page"]\')?.getAttribute("title") ?? null'
    )
  const centeredFile = () =>
    ui.until(
      `(() => {
    const tree=document.querySelector('nav[aria-label="Review files"]');
    const row=tree?.querySelector('[aria-current="page"]');
    if(!tree || !row)return false;
    const frame=tree.getBoundingClientRect(), rect=row.getBoundingClientRect();
    return tree.scrollHeight>tree.clientHeight && Math.abs((rect.top+rect.bottom-frame.top-frame.bottom)/2)<2;
  })()`,
      "active file centered in the tree"
    )
  await centeredFile()
  await ui.execute(
    "document.querySelector('nav[aria-label=\"Review files\"]').scrollTop=0;return true"
  )
  await Bun.sleep(2600)
  assert.equal(
    await ui.execute(
      "return document.querySelector('nav[aria-label=\"Review files\"]').scrollTop"
    ),
    0,
    "passive refresh does not recenter the tree"
  )
  await ui.named("Files")
  await ui.named("Files")
  await centeredFile()
  await ui.named("Files")
  await ui.named("Document", '[role="tab"]')
  await ui.named("Code", '[role="tab"]')
  await ui.until(
    'document.querySelector(\'aside[aria-label="Review files"]\')?.getAttribute("aria-hidden") === "false"',
    "returning to Code reopens a previously closed file tree"
  )
  await centeredFile()
  assert.equal(
    await selectedFile(),
    "src/other.ts",
    "a guided step highlights its source file"
  )
  await ui.named("Contents")
  await ui.named(
    "The new amount",
    '[data-slot="popover-content"] button',
    false
  )
  await ui.has("Step 1 of 11")
  await centeredFile()
  assert.equal(
    await selectedFile(),
    "src/answer.ts",
    "changing steps moves the file highlight"
  )
  await ui.named("Contents")
  await ui.named("Behavior 3", '[data-slot="popover-content"] button', false)
  await ui.has("Step 3 of 11")
  await centeredFile()
  assert.equal(await selectedFile(), "src/other.ts")
  await ui.named("value", 'aside[aria-label="Explanation"] article button')
  await ui.named("Open in code", '[data-slot="hover-card-content"] button')
  assert.equal(
    await selectedFile(),
    "src/other.ts",
    "a pinned source stays located in the tree"
  )
  await ui.has("Step 3 of 11")
  await ui.named("Close pinned reference")
  assert.equal(await selectedFile(), "src/other.ts")
  assert.equal(
    await ui.execute(
      `return getComputedStyle(document.querySelector(arguments[0])).opacity`,
      [otherFile]
    ),
    "1"
  )
  await ui.named("Validate step and continue")
  await ui.has("Step 4 of 11")
  assert.equal(
    await ui.execute(
      `return getComputedStyle(document.querySelector(arguments[0])).opacity`,
      [otherFile]
    ),
    "1",
    "other associated steps still need validation"
  )
  for (const step of [6, 9]) {
    await ui.named("Contents")
    await ui.named(
      `Behavior ${step}`,
      '[data-slot="popover-content"] button',
      false
    )
    await ui.named("Validate step and continue")
    await ui.has(`Step ${step + 1} of 11`)
  }
  await ui.until(
    `getComputedStyle(document.querySelector('${otherFile} > span')).opacity === '0.5'`
  )
  assert.equal(
    await ui.execute(
      `return getComputedStyle(document.querySelector('[data-folder="src"]')).opacity`
    ),
    "1",
    "folder keeps unreviewed files visible"
  )
  await ui.fill('input[aria-label="Filter files"]', "other.ts")
  assert.equal(
    await ui.execute(
      `return getComputedStyle(document.querySelector('[data-folder="src"]')).opacity`
    ),
    "1",
    "filter never makes a folder fully reviewed"
  )
  await ui.screenshot("reviewed-file-opacity")
  await ui.fill('input[aria-label="Filter files"]', "")
  await ui.named("Contents")
  await ui.named("Behavior 3", '[data-slot="popover-content"] button', false)
  await ui.named("Reopen step")
  await ui.until(
    `getComputedStyle(document.querySelector('${otherFile} > span')).opacity === '1'`
  )

  for (const activation of ["tab", "shortcut", "palette"]) {
    await ui.named("Code", '[role="tab"]')
    await ui.until(
      'document.querySelector(\'aside[aria-label="Review files"]\')?.getAttribute("aria-hidden") === "false"'
    )
    await centeredFile()
    // Explore files independently of step 3, including a file belonging to
    // another step. Every entry point back to Document must resume step 3.
    await ui.click(otherFile)
    await ui.click(
      'nav[aria-label="Review files"] button[title="src/answer.ts"]'
    )
    await ui.has("Validate file and continue")
    await centeredFile()
    assert.equal(
      await selectedFile(),
      "src/answer.ts",
      "manual file selection stays highlighted"
    )
    if (activation === "tab") await ui.named("Document", '[role="tab"]')
    else if (activation === "shortcut") {
      await ui.execute("document.activeElement?.blur();return true")
      await ui.keys("d")
    } else {
      await ui.keys("\uE03D", "k")
      await ui.fill('[role="combobox"]', "Switch document / code")
      await ui.named("Switch document / code", '[role="option"]', false)
    }
    await ui.has("Step 3 of 11")
    await ui.has("Validate step and continue")
    assert(
      await ui.execute(
        `return document.querySelector('[aria-label="Review document"]')?.textContent.includes('Behavior 3') && !document.querySelector('main[aria-label="Review"]').textContent.includes('Explore the captured file')`
      ),
      `${activation} returns to the last guided document`
    )
  }

  await ui.named("Document", '[role="tab"]')
  await ui.until(
    `document.querySelector('${panel}').getBoundingClientRect().width>=289`
  )
  assert(
    !(await ui.execute(
      `return !!document.querySelector('button[aria-label="Contents"]')`
    ))
  )
  await ui.resize(800, 900)
  await ui.screenshot("steps-narrow")
  assert.deepEqual((await ui.layout()).overflow, [])
  assert.deepEqual(await ui.execute("return window.__uiErrors"), [])
  console.log(
    "Native contents: external steps, resize, truncation, right tooltip, close/reopen, preserved document, selection, Code popover and document return via tab/shortcut/palette passed."
  )
} catch (error) {
  console.error(await ui.text().catch(() => ""))
  await ui.screenshot("failure").catch(() => {})
  throw error
} finally {
  await ui
    .execute(
      "if(arguments[1]===null)localStorage.removeItem(arguments[0]);else localStorage.setItem(arguments[0],arguments[1]);return true",
      [widthKey, savedWidth]
    )
    .catch(() => {})
  await ui.stop()
  await f.cleanup()
}
