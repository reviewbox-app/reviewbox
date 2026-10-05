import assert from "node:assert/strict"
import { access, readFile, realpath, unlink } from "node:fs/promises"
import { join } from "node:path"
import { fixture, NativeUI } from "../tests/native/ui-driver"

process.env.REVIEWBOX_NATIVE_PORT ??= "14484"
process.env.REVIEWBOX_NATIVE_ARTIFACTS ??= "artifacts/validation/project-skills"
const first = await fixture()
const second = await fixture()
const ui = new NativeUI()
const skills = [
  "reviewbox-project",
  "reviewbox-review",
  "reviewbox-comments",
  "reviewbox-changes",
]
const skillPath = (root: string, name: string) =>
  join(root, ".agents", "skills", name, "SKILL.md")
const exists = async (path: string) =>
  access(path).then(
    () => true,
    () => false
  )
let phase = "automatic import"
let window = "main"

async function openProject(path: string, switching = false) {
  if (switching) await ui.click('[title="Switch repository"]')
  await ui.named("or enter a path")
  await ui.fill('[aria-label="Repository path"]', path)
  await ui.named("Open")
  await ui.element('[data-testid="workspace-navigation"]')
}
async function openSettings() {
  await ui.named("Settings")
  await ui.wait(
    async () =>
      (await ui.request<string[]>(ui.route("/window/handles"))).includes(
        "settings"
      ),
    "settings window"
  )
  await ui.request(ui.route("/window"), { handle: "settings" })
  window = "settings"
  await ui.execute(
    "window.__uiErrors=[];window.addEventListener('error',e=>window.__uiErrors.push(e.message));window.addEventListener('unhandledrejection',e=>window.__uiErrors.push(String(e.reason)));window.BASE_UI_ANIMATIONS_DISABLED=true;return true"
  )
  await ui.resize(800, 700)
}
async function closeSettings() {
  const errors = await ui.execute<string[]>("return window.__uiErrors??[]")
  assert.deepEqual(
    errors.filter((error) => !error.includes("ResizeObserver loop")),
    []
  )
  await ui.request(ui.route("/window"), undefined, "DELETE")
  await ui.request(ui.route("/window"), { handle: "main" })
  window = "main"
}
async function projectSettings(path: string) {
  await ui.named("Project", "nav button")
  await ui.element("#settings-project")
  await ui.select(
    "#settings-project",
    `sample-project — ${await realpath(path)}`
  )
  await ui.until(
    "document.querySelector('[aria-label=\"Project skill import\"]') && !document.querySelector('[aria-label=\"Project skill import\"]').disabled",
    "project skill preferences loaded"
  )
}
async function chooseProject(value: string) {
  await ui.select('[aria-label="Project skill import"]', value)
  await ui.until(
    `document.querySelector('[aria-label="Project skill import"]')?.textContent.includes(${JSON.stringify(value)}) && !document.querySelector('[aria-label="Project skill import"]').disabled`,
    "project preference saved"
  )
}
async function globalImport(enabled: boolean) {
  await ui.named("General", "nav button")
  const selector = '[aria-label="Import project agent skills"]'
  await ui.until(
    `!!document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`,
    "global skill preference loaded"
  )
  if (
    (await ui.execute(
      `return document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-checked')==='true'`
    )) !== enabled
  )
    await ui.click(selector)
  await ui.until(
    `document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-checked')==='${enabled}' && !document.querySelector(${JSON.stringify(selector)}).disabled`,
    "global preference saved"
  )
}
async function importMissing() {
  await ui.named("Import missing files")
  await ui.has("files added;")
}
async function assertLayout(name: string) {
  await ui.execute(
    "document.querySelector('[aria-label=\"Project skill import\"]')?.scrollIntoView({block:'center'});return true"
  )
  const control = await ui.execute<{
    left: number
    right: number
    height: number
    parentLeft: number
    parentRight: number
  } | null>(
    `const e=document.querySelector('[aria-label="Project skill import"]');if(!e)return null;const r=e.getBoundingClientRect(),p=e.closest('section').getBoundingClientRect();return {left:r.left,right:r.right,height:r.height,parentLeft:p.left,parentRight:p.right}`
  )
  if (control) {
    assert(
      control.left >= control.parentLeft &&
        control.right <= control.parentRight,
      `${name}: project selector fits inside settings`
    )
    assert(control.height <= 40, `${name}: project selector remains compact`)
  }
  const layout = await ui.layout()
  assert.deepEqual(layout.overflow, [], `${name}: horizontal overflow at 800px`)
  assert.deepEqual(layout.clipped, [], `${name}: clipped controls at 800px`)
  await ui.screenshot(name)
}
try {
  await first.write(
    "AGENTS.md",
    "# Existing project instructions\nKeep this text exactly.\n"
  )
  await ui.start(join(first.root, "appdata"))
  await ui.execute("window.BASE_UI_ANIMATIONS_DISABLED=true;return true")
  await openProject(first.repo)
  await ui.wait(
    async () =>
      (
        await Promise.all(
          skills.map((name) => exists(skillPath(first.repo, name)))
        )
      ).every(Boolean),
    "four skills imported on explicit project open"
  )
  const agents = await readFile(join(first.repo, "AGENTS.md"), "utf8")
  assert(
    agents.startsWith(
      "# Existing project instructions\nKeep this text exactly.\n"
    )
  )
  assert.equal(agents.split("<!-- REVIEWBOX_SKILLS_START -->").length - 1, 1)
  for (const name of skills)
    assert(agents.includes(`.agents/skills/${name}/SKILL.md`))

  phase = "repair missing files without overwriting customized skills"
  const custom = "# User customized skill\nKeep this exact fixture text.\n"
  await first.write(".agents/skills/reviewbox-project/SKILL.md", custom)
  await unlink(skillPath(first.repo, "reviewbox-review"))
  await openSettings()
  await projectSettings(first.repo)
  await assertLayout("project-skills-800px")
  await importMissing()
  await ui.wait(
    () => exists(skillPath(first.repo, "reviewbox-review")),
    "missing skill restored"
  )
  assert.equal(
    await readFile(skillPath(first.repo, "reviewbox-project"), "utf8"),
    custom
  )
  assert.equal(await readFile(join(first.repo, "AGENTS.md"), "utf8"), agents)

  phase =
    "project opt-out preserves existing imports and prevents repair on reopening"
  await chooseProject("Do not import")
  await unlink(skillPath(first.repo, "reviewbox-review"))
  await closeSettings()
  await openProject(first.repo, true)
  assert.equal(await exists(skillPath(first.repo, "reviewbox-review")), false)
  assert.equal(
    await readFile(skillPath(first.repo, "reviewbox-project"), "utf8"),
    custom
  )
  assert.equal(await readFile(join(first.repo, "AGENTS.md"), "utf8"), agents)
  await openSettings()
  await projectSettings(first.repo)
  await ui.until(
    "document.querySelector('[aria-label=\"Project skill import\"]')?.textContent.includes('Do not import')"
  )
  await chooseProject("Use application setting")

  phase = "global opt-out blocks a second project without deleting the first"
  await globalImport(false)
  await assertLayout("global-skills-800px")
  await closeSettings()
  await openProject(second.repo, true)
  assert.equal(await exists(join(second.repo, ".agents")), false)
  assert.equal(await exists(join(second.repo, "AGENTS.md")), false)
  assert.equal(
    await readFile(skillPath(first.repo, "reviewbox-project"), "utf8"),
    custom
  )
  await openSettings()
  await projectSettings(second.repo)
  await chooseProject("Import missing skills")
  await ui.has("Imports are disabled in the application settings.")
  await ui.until(
    "Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim()==='Import missing files')?.disabled"
  )
  assert.equal(await exists(join(second.repo, ".agents")), false)

  phase = "global opt-in and explicit project import"
  await globalImport(true)
  await projectSettings(second.repo)
  await importMissing()
  await ui.wait(
    async () =>
      (
        await Promise.all(
          skills.map((name) => exists(skillPath(second.repo, name)))
        )
      ).every(Boolean),
    "second project skills imported"
  )
  const secondAgents = await readFile(join(second.repo, "AGENTS.md"), "utf8")
  const secondFiles = await Promise.all(
    skills.map((name) => readFile(skillPath(second.repo, name), "utf8"))
  )
  await chooseProject("Do not import")
  assert.equal(
    await readFile(join(second.repo, "AGENTS.md"), "utf8"),
    secondAgents
  )
  assert.deepEqual(
    await Promise.all(
      skills.map((name) => readFile(skillPath(second.repo, name), "utf8"))
    ),
    secondFiles
  )
  await closeSettings()
  assert.equal(first.git("write-tree").trim(), first.index.trim())
  assert.equal(second.git("write-tree").trim(), second.index.trim())
  const errors = await ui.execute<string[]>("return window.__uiErrors??[]")
  assert.deepEqual(
    errors.filter((error) => !error.includes("ResizeObserver loop")),
    []
  )
  console.log(
    "Native project skills: automatic import, original AGENTS preserved, customized skill retained, missing-file repair, project opt-out on reopen, global opt-out in second project, global precedence, explicit reimport, 800px settings and untouched Git indexes passed."
  )
} catch (error) {
  await ui.screenshot(`failed-${phase.replaceAll(" ", "-")}`).catch(() => {})
  console.error({
    phase,
    window,
    text: await ui.text().catch(() => "unavailable"),
  })
  throw new Error(`${phase}: ${error}`, { cause: error })
} finally {
  await ui.stop()
  await first.cleanup()
  await second.cleanup()
}
