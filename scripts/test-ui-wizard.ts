import assert from "node:assert/strict"
import { chmod, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { NativeUI, fixture } from "../tests/native/ui-driver"
import type {
  ProjectSettings,
  Review,
} from "../src/lib/desktop/contracts.generated"

// Only the harness readiness probes are faked. Every product action goes through
// the native WebView; no installation, real login or AI request is executed.
const f = await fixture()
const ui = new NativeUI()
const auth = join(f.root, "codex-authenticated")
const unexpected = join(f.root, "unexpected-provider-command")
const codex = join(f.root, "codex-wizard-fixture")
const claude = join(f.root, "claude-wizard-fixture")
const reports: unknown[] = []
const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`
await writeFile(
  codex,
  `#!/bin/sh
if [ "$1" = --version ]; then echo 'codex-cli 0.157.0'; exit 0; fi
if [ "$1 $2" = 'login status' ]; then
  if [ -f ${quote(auth)} ]; then echo 'Logged in using ChatGPT'; exit 0; fi
  echo 'Not logged in' >&2; exit 1
fi
printf '%s\\n' "$*" >> ${quote(unexpected)}
exit 2
`
)
await writeFile(
  claude,
  `#!/bin/sh
if [ "$1" = --version ]; then echo '2.1.281 (Claude Code)'; exit 0; fi
if [ "$1 $2" = 'auth status' ]; then echo '{"loggedIn":false}'; exit 1; fi
printf '%s\\n' "$*" >> ${quote(unexpected)}
exit 2
`
)
await chmod(codex, 0o700)
await chmod(claude, 0o700)

const dialog = '[role="dialog"]'
const stepper = `${dialog} [aria-label="New review steps"]`
const scopeGroup = `${dialog} [aria-label="Review scope"]`
const preparationGroup = `${dialog} [aria-label="Review preparation"]`
const reviewIds = () =>
  readdir(`${f.repo}/.reviewbox/reviews`).catch(() => [] as string[])
const projectSettings = async () =>
  (await Bun.file(`${f.repo}/.reviewbox/settings.json`).json())
    .data as ProjectSettings

async function settings(section: "General" | "Rev") {
  const handles = await ui.request<string[]>(ui.route("/window/handles"))
  if (!handles.includes("settings")) {
    await ui.named("Settings")
    await ui.wait(
      async () =>
        (await ui.request<string[]>(ui.route("/window/handles"))).includes(
          "settings"
        ),
      "settings window"
    )
  }
  await ui.request(ui.route("/window"), { handle: "settings" })
  await ui.named(section, "nav button")
}
async function main() {
  await ui.request(ui.route("/window"), { handle: "main" })
}
async function theme(value: "Dark" | "Light") {
  await settings("General")
  await ui.named(value, "[role=tab]")
  await ui.until(
    `document.documentElement.classList.contains(${JSON.stringify(value.toLowerCase())})`
  )
  await main()
  await ui.until(
    `document.documentElement.classList.contains(${JSON.stringify(value.toLowerCase())})`,
    `main theme ${value}`
  )
}
async function steps(
  count: number,
  current: "Rev" | "What to review" | "Preparation"
) {
  await ui.until(
    `document.querySelectorAll(${JSON.stringify(`${stepper} > li`)}).length === ${count}`,
    `${count} steps`
  )
  assert.match(
    await ui.execute<string>(
      `return document.querySelector(${JSON.stringify(`${stepper} [aria-current=step]`)})?.textContent ?? ''`
    ),
    new RegExp(current)
  )
}
async function reopen() {
  await ui.keys("\uE03D", "n")
  await ui.has("New review")
  await ui.element(stepper)
}
async function closeWithEscape() {
  await ui.keys("\uE00C")
  await ui.until(
    `!document.querySelector(${JSON.stringify(dialog)})`,
    "wizard closed"
  )
}
async function checked(group: string, label: string, disabled?: boolean) {
  const expression = `[...document.querySelectorAll(${JSON.stringify(`${group} label`)})].find(e=>e.textContent.includes(${JSON.stringify(label)}))?.querySelector('[role=radio]')`
  await ui.until(
    `(${expression})?.getAttribute('aria-checked') === 'true'`,
    `${label} checked`
  )
  if (disabled !== undefined)
    assert.equal(
      await ui.execute(
        `return !!(${expression})?.disabled || (${expression})?.getAttribute('aria-disabled') === 'true'`
      ),
      disabled
    )
}
async function focusSelected(group: string) {
  await ui.execute(
    `const element=document.querySelector(${JSON.stringify(`${group} [role=radio][aria-checked=true]`)});element.focus();return true`
  )
}
async function readyNext() {
  await ui.until(
    "[...document.querySelectorAll('[role=dialog] footer button')].some(e=>e.textContent.trim()==='Next' && !e.disabled)",
    "Next ready"
  )
}
async function layout(name: string) {
  for (const [width, height] of [
    [1440, 900],
    [800, 600],
  ]) {
    await ui.resize(width, height)
    const result = await ui.layout()
    assert.deepEqual(
      result.overflow,
      [],
      `${name}: horizontal scrolling at ${width}×${height}`
    )
    assert.deepEqual(
      result.clipped,
      [],
      `${name}: clipped header controls at ${width}×${height}`
    )
    const footer = await ui.execute<{
      left: number
      right: number
      bottom: number
      height: number
      width: number
    }>(
      `const r=document.querySelector('[role=dialog] footer').getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom,height:innerHeight,width:innerWidth}`
    )
    assert(
      footer.left >= 0 &&
        footer.right <= footer.width + 1 &&
        footer.bottom <= footer.height + 1,
      `${name}: footer must stay accessible`
    )
    reports.push({ name, height, ...result })
    await ui.screenshot(`wizard-${name}-${width}x${height}`)
  }
  await ui.resize(1440, 900)
}
async function expectNoReviews() {
  assert.deepEqual(
    await reviewIds(),
    [],
    "Abandoning a wizard must not publish a review"
  )
}
async function waitForReview() {
  await ui.until(
    `!document.querySelector(${JSON.stringify(dialog)})`,
    "capture finished"
  )
  await ui.until(
    "!!document.querySelector('[aria-label=\"Code diff\"] .monaco-editor')",
    "captured review editor"
  )
}

try {
  await ui.start(`${f.root}/appdata`)
  await settings("Rev")
  await ui.setHarnessExecutable("codex", codex)
  await ui.setHarnessExecutable("claude", claude)
  await ui.has("Sign in required")
  await main()

  for (const appearance of ["Dark", "Light"] as const) {
    await theme(appearance)
    if (appearance === "Dark") {
      await ui.named("or enter a path")
      await ui.fill('[aria-label="Repository path"]', f.repo)
      await ui.named("Open")
    } else await reopen()
    await ui.has("Choose Rev’s harness")
    await steps(3, "Rev")
    assert(
      await ui.execute(
        "return [...document.querySelectorAll('[role=dialog] footer button')].find(e=>e.textContent.trim()==='Next')?.disabled"
      ),
      "Signed-out harness must block Next"
    )
    await layout(`${appearance.toLowerCase()}-rev`)
    await ui.named("Continue without Rev", `${dialog} footer button`)
    await steps(3, "What to review")
    await ui.named("Local changes", `${dialog} label`, false)
    await ui.click(`${dialog} [role=checkbox]`)
    await readyNext()
    await layout(`${appearance.toLowerCase()}-scope`)
    // Enter should advance when a scope radio has focus. Cmd+Enter cannot start
    // a review before Preparation, even if the scope is already valid.
    await focusSelected(scopeGroup)
    await ui.keys("\uE03D", "\uE007")
    await steps(3, "What to review")
    await expectNoReviews()
    await focusSelected(scopeGroup)
    await ui.keys("\uE007")
    await ui.element(preparationGroup)
    await steps(3, "Preparation")
    await checked(preparationGroup, "Myself")
    assert(
      await ui.execute(
        `const radio = [...document.querySelectorAll(${JSON.stringify(`${preparationGroup} label`)})].find(e=>e.textContent.includes('With Rev'))?.querySelector('[role=radio]'); return !!radio?.disabled || radio?.getAttribute('aria-disabled') === 'true'`
      ),
      "Continue without Rev must disable With Rev"
    )
    await layout(`${appearance.toLowerCase()}-preparation`)
    // Plain Enter is deliberately insufficient to start a review here.
    await focusSelected(preparationGroup)
    await ui.keys("\uE007")
    await steps(3, "Preparation")
    await expectNoReviews()
    await ui.named("Change", `${dialog} button`)
    await checked(scopeGroup, "Local changes")
    assert.equal(
      await ui.execute(
        `return document.querySelector(${JSON.stringify(`${dialog} [role=checkbox]`)})?.getAttribute('aria-checked')`
      ),
      "true",
      "Change keeps the untracked choice"
    )
    await ui.named("A range of commits", `${dialog} label`, false)
    await ui.reviewReference("Base reference", "HEAD~1")
    await ui.reviewReference("Target reference", "HEAD")
    await ui.nextReviewStep()
    await ui.named("Back", `${dialog} footer button`)
    await checked(scopeGroup, "A range of commits")
    assert.equal(
      await ui.execute(
        "return document.querySelector('[aria-label=\"Base reference\"]')?.value"
      ),
      "HEAD~1"
    )
    assert.equal(
      await ui.execute(
        "return document.querySelector('[aria-label=\"Target reference\"]')?.value"
      ),
      "HEAD"
    )
    await closeWithEscape()
    await expectNoReviews()
  }

  // A completed manual capture persists only the selected defaults; unfinished
  // drafts above leave the project's initial settings unchanged.
  const originalSettings = await projectSettings()
  assert.equal(originalSettings.defaultScope, "local")
  assert.equal(originalSettings.includeUntracked, true)
  await reopen()
  await ui.reviewScope()
  await ui.named("Local changes", `${dialog} label`, false)
  await ui.click(`${dialog} [role=checkbox]`)
  await ui.nextReviewStep()
  await checked(preparationGroup, "Myself")
  await focusSelected(preparationGroup)
  await ui.keys("\uE03D", "\uE007")
  await waitForReview()
  const [firstId] = await reviewIds()
  assert(firstId)
  assert.equal((await reviewIds()).length, 1)
  let saved = await projectSettings()
  assert.equal(saved.defaultScope, "local")
  assert.equal(saved.includeUntracked, false)
  assert.equal(saved.defaultPreparation, "manual")
  await ui.click('aside button[title="src/other.ts"]')
  await ui.until(
    '!!document.querySelector(\'[aria-label="Code diff"] header [title="src/other.ts"]\')'
  )
  const previous = await ui.execute<string>(
    "return document.querySelector('aside header')?.textContent ?? ''"
  )

  // Readiness may change in place; this draft must retain its three-step layout.
  await reopen()
  await steps(3, "Rev")
  await writeFile(auth, "authenticated fixture\n")
  await ui.named("Detect again", `${dialog} button`)
  await ui.has("Codex is ready")
  await steps(3, "Rev")
  await ui.nextReviewStep()
  await steps(3, "What to review")
  await ui.named("Back", `${dialog} footer button`)
  await steps(3, "Rev")
  await ui.nextReviewStep()
  await ui.named("A commit", `${dialog} label`, false)
  await ui.reviewReference("Commit", "HEAD")
  await ui.nextReviewStep()
  await steps(3, "Preparation")
  await closeWithEscape()
  assert.deepEqual(await reviewIds(), [firstId])
  assert.equal(
    await ui.execute(
      "return document.querySelector('aside header')?.textContent ?? ''"
    ),
    previous,
    "Closing preserves the previous review identity"
  )
  assert(
    await ui.execute(
      'return !!document.querySelector(\'[aria-label="Code diff"] header [title="src/other.ts"]\')'
    ),
    "Closing preserves the previously selected file"
  )

  // The next draft sees the ready harness immediately and has only two steps.
  await reopen()
  await ui.element(scopeGroup)
  await steps(2, "What to review")
  await checked(scopeGroup, "Local changes")
  assert.equal(
    await ui.execute(
      `return document.querySelector(${JSON.stringify(`${dialog} [role=checkbox]`)})?.getAttribute('aria-checked')`
    ),
    "true"
  )
  await ui.named("Unstaged changes", `${dialog} label`, false)
  await ui.nextReviewStep()
  await steps(2, "Preparation")
  await checked(preparationGroup, "Myself")
  await ui.named("With Rev", `${dialog} label`, false)
  await checked(preparationGroup, "With Rev", false)
  await ui.named("Myself", `${dialog} label`, false)
  await focusSelected(preparationGroup)
  await ui.keys("\uE03D", "\uE007")
  await waitForReview()
  assert.equal((await reviewIds()).length, 2)
  saved = await projectSettings()
  assert.equal(saved.defaultScope, "unstaged")
  assert.equal(saved.includeUntracked, false)
  assert.equal(saved.defaultPreparation, "manual")
  const nextId = (await reviewIds()).find((id) => id !== firstId)!
  const review = (
    await Bun.file(`${f.repo}/.reviewbox/reviews/${nextId}/review.json`).json()
  ).data as Review
  assert.deepEqual(review.topics, [], "Myself starts without generated topics")
  assert.deepEqual(review.decisions, [], "Preparation never validates code")
  assert.equal(
    await Bun.file(unexpected).exists(),
    false,
    "This suite must never launch an AI request or installer"
  )
  assert.equal(
    f.git("write-tree"),
    f.index,
    "Wizard leaves the Git index untouched"
  )
  assert.deepEqual(await ui.execute("return window.__uiErrors"), [])
  await Bun.write(
    `${ui.artifacts}/wizard-layouts.json`,
    JSON.stringify(reports, null, 2)
  )
  console.log(
    "Native wizard: three/two steps, skipped and detected harness, retained draft/context, shortcuts, persisted defaults, and dark/light 1440×900 + 800×600 layouts passed"
  )
} catch (error) {
  await ui.screenshot("wizard-failure").catch(() => {})
  console.error(await ui.text().catch(() => "No native UI"))
  throw error
} finally {
  await ui.stop()
  await rm(auth, { force: true })
  await f.cleanup()
}
