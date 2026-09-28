import assert from "node:assert/strict"
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { NativeUI, fixture } from "../tests/native/ui-driver"

const f = await fixture()
const ui = new NativeUI()
// A realistic npm wrapper path, including spaces and an apostrophe. Never
// install, update or authenticate a real provider during this regression test.
const prefix = join(f.root, "fixture's node installation")
const binary = join(prefix, "lib/node_modules/@openai/codex/bin/codex.js")
const executable = join(prefix, "bin/codex")
const claude = join(f.root, "claude-fixture")
await mkdir(dirname(binary), { recursive: true })
await mkdir(dirname(executable), { recursive: true })
await symlink(binary, executable)
await writeFile(
  claude,
  '#!/bin/sh\nif [ "$1" = --version ]; then echo "2.1.281 (Claude Code)"; elif [ "$1 $2" = "auth status" ]; then echo \'{"loggedIn":true}\'; else exit 1; fi\n'
)
await chmod(claude, 0o700)
async function version(
  value: string,
  auth: "ready" | "signedOut" | "unknown" = "ready"
) {
  const status =
    auth === "ready"
      ? "echo 'Logged in using ChatGPT'; exit 0"
      : auth === "signedOut"
        ? "echo 'Not logged in' >&2; exit 1"
        : "echo 'Invalid configuration' >&2; exit 1"
  await writeFile(
    binary,
    `#!/bin/sh\nif [ "$1" = --version ]; then echo '${value}'; elif [ "$1 $2" = 'login status' ]; then ${status}; else exit 1; fi\n`
  )
  await chmod(binary, 0o700)
}
async function settings() {
  await ui.named("Settings")
  await ui.wait(
    async () =>
      (await ui.request<string[]>(ui.route("/window/handles"))).includes(
        "settings"
      ),
    "settings window"
  )
  await ui.request(ui.route("/window"), { handle: "settings" })
  await ui.named("Rev", "nav button")
}
async function main() {
  await ui.request(ui.route("/window"), { handle: "main" })
}
const sendDisabled =
  "document.querySelector('button[aria-label=\"Ask Rev\"]')?.disabled"
const revReady =
  "[...document.querySelectorAll('header [role=status]')].some(e=>/^Rev\\s*ready$/.test(e.textContent.trim()))"
try {
  await version("codex-cli 0.147.0")
  await ui.start(`${f.root}/appdata`)
  await ui.named("or enter a path")
  await ui.fill('[aria-label="Repository path"]', f.repo)
  await ui.named("Open")
  await ui.startManualReview()
  await ui.until("!!document.querySelector('.monaco-editor')")
  await settings()
  await ui.setHarnessExecutable("codex", executable)
  await ui.setHarnessExecutable("claude", claude)
  await ui.has("Outdated")
  await ui.harnessOption("codex", "Details")
  await ui.has("0.157.0")
  await ui.named("Cancel")
  assert.equal(
    await ui.execute(
      "return document.querySelector('#default-provider')?.textContent.trim()"
    ),
    "Codex",
    "readiness fallback must not overwrite the configured harness"
  )
  await ui.resize(800, 700)
  const layout = await ui.layout()
  assert.deepEqual(layout.overflow, [], "update guidance must wrap")
  assert.deepEqual(layout.clipped, [], "update actions must fit")
  await ui.screenshot("codex-update-required")
  await main()
  await ui.until(
    revReady,
    "Rev stays ready through the authenticated Claude fallback"
  )
  await ui.resize(800, 700)
  const mainLayout = await ui.layout()
  assert.deepEqual(
    mainLayout.overflow,
    [],
    "fallback ready badge must fit the main window"
  )
  assert.deepEqual(
    mainLayout.clipped,
    [],
    "main window controls must stay visible"
  )
  // Manual validation remains available with an unsupported harness.
  await ui.named("Validate passage")
  await ui.has("Validated")
  // Harness readiness is visible where Rev still talks: Code Explain.
  await ui.named("Code Explain", '[role="tab"]')
  await ui.named("Explain with Rev")
  await ui.fill('[aria-label="Question for Rev"]', "Explain this change")
  await ui.has("Codex is too old")
  await ui.until(sendDisabled)
  await ui.select('select[aria-label="Rev\'s harness"]', "claude")
  await ui.until(`!${sendDisabled}`)
  await ui.select('select[aria-label="Rev\'s harness"]', "codex")
  await ui.until(sendDisabled)
  await version("codex-cli 0.157.0")
  await ui.request(ui.route("/window"), { handle: "settings" })
  await ui.harnessOption("codex", "Redetect")
  await ui.harnessOption("codex", "Details")
  await ui.has("codex-cli 0.157.0")
  await ui.named("Cancel")
  await ui.until("!document.body.innerText.includes('Codex is too old')")
  await main()
  await ui.until(`!${sendDisabled}`)
  await ui.until(
    "document.querySelector('[aria-label=\"Question for Rev\"]')?.value === 'Explain this change'"
  )
  for (const authentication of ["signedOut", "unknown"] as const) {
    await version("codex-cli 0.157.0", authentication)
    await ui.request(ui.route("/window"), { handle: "settings" })
    await ui.harnessOption("codex", "Redetect")
    await ui.has(
      authentication === "signedOut"
        ? "Sign in required"
        : "Verification failed"
    )
    await main()
    await ui.until(
      revReady,
      "Claude fallback stays ready while Codex is unavailable"
    )
    await ui.until(sendDisabled)
    assert.equal(
      await ui.execute(
        "return document.querySelector('[aria-label=\"Question for Rev\"]')?.value"
      ),
      "Explain this change",
      "readiness changes preserve the question draft"
    )
  }
  // A version that cannot be parsed must never silently enable the harness.
  await version("codex-cli unknown")
  await ui.request(ui.route("/window"), { handle: "settings" })
  await ui.harnessOption("codex", "Redetect")
  await ui.has("Unknown version")
  await main()
  await ui.has("Cannot read the harness version")
  await ui.until(sendDisabled)
  await ui.request(ui.route("/window"), { handle: "settings" })
  await ui.setHarnessExecutable("codex", `${f.root}/missing-codex`)
  await ui.has("Not detected")
  await main()
  await ui.has("Executable unavailable")
  await ui.until(sendDisabled)
  assert.equal(f.git("write-tree"), f.index, "Git index stays untouched")
  assert.deepEqual(await ui.execute("return window.__uiErrors"), [])
  console.log(
    "Native Codex readiness: old, supported, signed out, verification failure, unknown, missing, cross-window refresh, retained draft, manual validation and 800px layout passed"
  )
} catch (error) {
  await ui.screenshot("compatibility-failure").catch(() => {})
  console.error(await ui.text().catch(() => ""))
  throw error
} finally {
  await ui.stop()
  await f.cleanup()
}
