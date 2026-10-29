import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { fixture, NativeUI } from "../tests/native/ui-driver"

process.env.REVIEWBOX_NATIVE_ARTIFACTS ??= "artifacts/validation/terminal"
const f = await fixture()
const ui = new NativeUI()
let phase = "open"
const paste = async (command: string) => {
  await ui.click('section[aria-label="Terminal workspace"] .xterm-screen')
  await ui.execute(
    `const input=document.querySelector('section[aria-label="Terminal workspace"] .xterm-helper-textarea');input.focus();const data=new DataTransfer();data.setData('text/plain',arguments[0]);input.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));return true`,
    [command]
  )
  await ui.keys("\uE007")
}
const output = (needle: string) =>
  ui.until(
    `document.querySelector('section[aria-label="Terminal workspace"] .xterm-rows')?.textContent.replaceAll('\u00a0', ' ').includes(${JSON.stringify(needle)})`
  )
try {
  const vimText =
    "Terminal unicode é漢字🙂\n" +
    Array.from({ length: 120 }, (_, i) => `Line ${i + 1}`).join("\n") +
    "\n"
  await f.write("terminal-vim.txt", vimText)
  await ui.start(join(f.root, "appdata"))
  await ui.named("or enter a path")
  await ui.fill('[aria-label="Repository path"]', f.repo)
  await ui.named("Open")
  await ui.named("Terminal", '[data-testid="workspace-navigation"] [role=tab]')
  await ui.element('[aria-label="Terminals"] [role=tab]')
  await ui.until("!!document.querySelector('.xterm-helper-textarea')")
  phase = "transparent terminal surfaces in both themes"
  const originalDark = await ui.execute<boolean>(
    "return document.documentElement.classList.contains('dark')"
  )
  for (const dark of [false, true]) {
    await ui.execute(
      "document.documentElement.classList.toggle('dark', arguments[0]); return true",
      [dark]
    )
    await ui.until(
      `(() => {
      const terminal = document.querySelector('section[aria-label="Terminal workspace"] .xterm');
      const surfaces = ['.xterm-viewport', '.xterm-scrollable-element', '.xterm-screen', '.xterm-rows'];
      return surfaces.every(selector => {
        const element = terminal?.querySelector(selector);
        return element && getComputedStyle(element).backgroundColor === 'rgba(0, 0, 0, 0)';
      });
    })()`,
      "terminal layers expose the panel background"
    )
    await ui.screenshot(
      dark ? "terminal-transparent-dark" : "terminal-transparent-light"
    )
  }
  await ui.execute(
    "document.documentElement.classList.toggle('dark', arguments[0]); return true",
    [originalDark]
  )
  phase = "real shell input and output"
  await paste(
    "printf 'REVIEWBOX_%s\\n' 'TERMINAL_OK'; printf ready > terminal-proof.txt; printf %s \"$$\" > terminal-shell.pid"
  )
  await output("REVIEWBOX_TERMINAL_OK")
  await ui.wait(async () => {
    try {
      return (
        (await readFile(join(f.repo, "terminal-proof.txt"), "utf8")) ===
          "ready" &&
        !!(await readFile(join(f.repo, "terminal-shell.pid"), "utf8"))
      )
    } catch {
      return false
    }
  }, "shell completed the fixture command")
  const shellPid = (
    await readFile(join(f.repo, "terminal-shell.pid"), "utf8")
  ).trim()
  assert.match(shellPid, /^\d+$/)
  assert.equal(
    await readFile(join(f.repo, "terminal-proof.txt"), "utf8"),
    "ready"
  )
  phase = "Unicode and full-screen terminal resize"
  await paste(
    "printf 'UNICODE_%s\\n' 'é漢字🙂'; stty size > terminal-before-size.txt"
  )
  await output("UNICODE_é漢字🙂")
  await paste("/usr/bin/vi -Nu NONE -n terminal-vim.txt")
  await output("Terminal unicode é漢字🙂")
  await ui.resize(1100, 740)
  await output("Terminal unicode é漢字🙂")
  await ui.keys("\uE00C")
  await ui.keys(":")
  await ui.keys("q")
  await ui.keys("!")
  await ui.keys("\uE007")
  await paste("stty size > terminal-after-size.txt; printf 'VIM_%s\\n' DONE")
  await output("VIM_DONE")
  await ui.wait(async () => {
    try {
      return !!(
        await readFile(join(f.repo, "terminal-after-size.txt"), "utf8")
      ).trim()
    } catch {
      return false
    }
  }, "PTY reported resized dimensions")
  const beforeSize = (
    await readFile(join(f.repo, "terminal-before-size.txt"), "utf8")
  )
    .trim()
    .split(/\s+/)
    .map(Number)
  const afterSize = (
    await readFile(join(f.repo, "terminal-after-size.txt"), "utf8")
  )
    .trim()
    .split(/\s+/)
    .map(Number)
  assert.equal(afterSize.length, 2)
  assert(afterSize.every((value) => Number.isInteger(value) && value > 0))
  assert.notDeepEqual(afterSize, beforeSize)
  assert.equal(
    await readFile(join(f.repo, "terminal-vim.txt"), "utf8"),
    vimText
  )
  phase = "session survives navigation"
  await paste("export REVIEWBOX_TERMINAL_TEST=kept")
  await ui.named(
    "Code Editor",
    '[data-testid="workspace-navigation"] [role=tab]'
  )
  await ui.named("Terminal", '[data-testid="workspace-navigation"] [role=tab]')
  await paste("printf 'PRESERVED_%s\\n' \"$REVIEWBOX_TERMINAL_TEST\"")
  await output("PRESERVED_kept")
  phase = "independent tabs"
  await ui.click('[aria-label="New terminal"]')
  await ui.until(
    "document.querySelectorAll('[aria-label=Terminals] [role=tab]').length===2"
  )
  await paste("printf 'ISOLATED_%s\\n' \"${REVIEWBOX_TERMINAL_TEST:-empty}\"")
  await output("ISOLATED_empty")
  phase = "search and exit"
  await ui.click('[aria-label="Find in terminal"]')
  await ui.fill('input[aria-label="Find in terminal"]', "ISOLATED_empty")
  await ui.click('[aria-label="Next match"]')
  await ui.until(
    "!!document.querySelector('section[aria-label=\"Terminal workspace\"] .xterm-selection > div')",
    "search selected a terminal match"
  )
  await ui.click('[aria-label="Close terminal search"]')
  await paste("exit 7")
  await ui.has("Process exited with code 7")
  await ui.screenshot("terminal-tabs")
  phase = "relaunch and rename"
  await ui.named("Relaunch")
  await ui.until(
    "document.querySelectorAll('[aria-label=Terminals] [role=tab]').length===2 && !document.body.innerText.includes('Process exited with code 7')"
  )
  await paste("printf 'RELAUNCH_%s\\n' OK")
  await output("RELAUNCH_OK")
  await ui.execute(
    "document.querySelector('[aria-label=Terminals] [role=tab][aria-selected=true]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true}));return true"
  )
  await ui.fill('[aria-label="Terminal name"]', "Verification shell")
  await ui.named("Rename", "[role=dialog] button")
  await ui.has("Verification shell")
  await paste("exit 0")
  await ui.has("Process exited with code 0")
  phase = "active tab close confirmation"
  await ui.click('[aria-label="Terminals"] [role=tab]:first-child')
  await ui.click('[aria-label="Terminals"] button[aria-label^="Close"]')
  await ui.has("Running commands in this terminal will stop.")
  await ui.named("Cancel", "[role=dialog] button")
  await paste("printf 'STILL_%s\\n' alive")
  await output("STILL_alive")
  await ui.click('[aria-label="Terminals"] button[aria-label^="Close"]')
  await ui.named("Close terminal", "[role=dialog] button")
  await ui.until(
    "document.querySelectorAll('[aria-label=Terminals] [role=tab]').length===1"
  )
  await ui.wait(async () => {
    const process = Bun.spawnSync(["ps", "-o", "stat=", "-p", shellPid])
    const state = process.stdout.toString().trim()
    return state === "" || state.startsWith("Z")
  }, "closed terminal shell exited")
  assert.equal(f.git("write-tree").trim(), f.index.trim())
  const errors = await ui.execute<string[]>("return window.__uiErrors")
  assert.deepEqual(
    errors.filter((e) => !e.includes("ResizeObserver loop")),
    []
  )
  console.log(
    "Native Terminal: real shell IO, Unicode, vi full-screen and PTY resize, independent tabs, retained sessions, search, exit status, relaunch/rename, close cancellation and cleanup passed."
  )
} catch (error) {
  await ui.screenshot(`failed-${phase.replaceAll(" ", "-")}`).catch(() => {})
  throw new Error(`${phase}: ${error}`, { cause: error })
} finally {
  await ui.stop()
  await f.cleanup()
}
