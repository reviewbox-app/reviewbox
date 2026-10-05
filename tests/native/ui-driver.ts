import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

/** Drives the actual Tauri WebView. Product actions use WebDriver, never IPC. */
export class NativeUI {
  constructor(
    private readonly binary = process.env.REVIEWBOX_NATIVE_BINARY ??
      resolve("src-tauri/target/debug/reviewbox")
  ) {}
  session = ""
  readonly port = Number(process.env.REVIEWBOX_NATIVE_PORT ?? 14446)
  readonly artifacts = resolve(
    process.env.REVIEWBOX_NATIVE_ARTIFACTS ?? "artifacts/validation/ui"
  )
  private child?: ReturnType<typeof Bun.spawn>
  async request<T>(path: string, body?: unknown, method?: string): Promise<T> {
    const response = await fetch(`http://127.0.0.1:${this.port}${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30000),
    })
    const result = (await response.json()) as { value: T }
    assert(response.ok, JSON.stringify(result))
    return result.value
  }
  route(path: string) {
    return `/session/${this.session}${path}`
  }
  async start(data: string) {
    await mkdir(this.artifacts, { recursive: true })
    this.child = Bun.spawn([this.binary], {
      env: {
        ...process.env,
        TAURI_WEBDRIVER_PORT: String(this.port),
        REVIEWBOX_VALIDATION_DATA: data,
      },
      stdout: Bun.file(join(this.artifacts, "native.log")),
      stderr: Bun.file(join(this.artifacts, "native-error.log")),
    })
    await this.wait(
      async () => {
        try {
          await this.request("/status")
          return true
        } catch {
          return false
        }
      },
      "native driver",
      30000
    )
    // The bundled app can expose /status before macOS creates its first window.
    await this.wait(
      async () => {
        try {
          this.session = (
            await this.request<{ sessionId: string }>("/session", {
              capabilities: { alwaysMatch: { browserName: "tauri" } },
            })
          ).sessionId
          return true
        } catch (error) {
          if (String(error).includes('"error":"no such window"')) return false
          throw error
        }
      },
      "native window",
      30000
    )
    // The initial navigation can replace the WebDriver script bridge while it
    // is installing. Retry only this read, never a user action or mutation.
    await this.wait(
      async () => {
        try {
          return await this.execute("return !!document.querySelector('h1')")
        } catch (error) {
          if (error instanceof DOMException && error.name === "TimeoutError")
            return false
          throw error
        }
      },
      "home",
      45000
    )
    await this.execute(
      `window.__uiErrors=[];window.addEventListener('error',e=>window.__uiErrors.push(e.message));window.addEventListener('unhandledrejection',e=>window.__uiErrors.push(String(e.reason)));return true`
    )
    await this.activateWindow()
  }
  private async activateWindow() {
    assert(this.child, "Start the validation process before activating it")
    if (process.platform === "darwin") {
      // Target this fixture's process: the installed app can share its bundle ID.
      const activation = Bun.spawn(
        [
          "osascript",
          "-l",
          "JavaScript",
          "-e",
          `ObjC.import('AppKit'); function run(argv) {
            const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(argv[0]));
            return app.activateWithOptions(3);
          }`,
          String(this.child.pid),
        ],
        { stdout: "pipe", stderr: "pipe" }
      )
      const [exitCode, error] = await Promise.all([
        activation.exited,
        new Response(activation.stderr).text(),
      ])
      assert.equal(
        exitCode,
        0,
        `Could not activate the native test window: ${error}`
      )
    }
    await this.execute(
      "window.__nativeValidationFrame=false;requestAnimationFrame(()=>window.__nativeValidationFrame=true);return true"
    )
    try {
      await this.wait(
        () =>
          this.execute(
            "return document.visibilityState==='visible' && window.__nativeValidationFrame===true"
          ),
        "visible native window with an active rendering loop",
        8000
      )
    } catch (error) {
      throw new Error(
        "Native UI validation requires a visible desktop session. Unlock macOS and keep the validation window visible; WebKit suspends Monaco and terminal rendering while the session is locked or hidden.",
        { cause: error }
      )
    } finally {
      await this.execute(
        "delete window.__nativeValidationFrame;return true"
      ).catch(() => {})
    }
  }
  execute<T = unknown>(script: string, args: unknown[] = []) {
    return this.request<T>(this.route("/execute/sync"), { script, args })
  }
  async wait(
    predicate: () => Promise<unknown>,
    label: string,
    timeout = 12000
  ) {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      if (await predicate()) return
      await Bun.sleep(100)
    }
    throw new Error(`Timed out: ${label}`)
  }
  until(expression: string, label = expression) {
    return this.wait(() => this.execute(`return ${expression}`), label)
  }
  text() {
    return this.execute<string>("return document.body.innerText")
  }
  has(text: string) {
    return this.until(
      `document.body.innerText.includes(${JSON.stringify(text)})`,
      text
    )
  }
  async element(selector: string) {
    await this.until(
      `!!document.querySelector(${JSON.stringify(selector)})`,
      selector
    )
    return (
      await this.request<Record<string, string>>(this.route("/element"), {
        using: "css selector",
        value: selector,
      })
    )["element-6066-11e4-a52e-4f735466cecf"]
  }
  async click(selector: string) {
    for (let attempt = 0; ; attempt++) {
      const id = await this.element(selector)
      try {
        await this.request(this.route(`/element/${id}/click`), {})
        break
      } catch (error) {
        // The driver rejects a detached element before dispatching the click.
        // Re-resolve it once after a background render; never retry a sent action.
        if (
          attempt ||
          !String(error).includes('"error":"stale element reference"')
        )
          throw error
        await this.execute(
          `const errors=window.__uiErrors??[];const index=errors.lastIndexOf('Error: stale element reference');if(index>=0)errors.splice(index,1);return true`
        )
      }
    }
    await Bun.sleep(80)
  }
  async named(name: string, selector = "button", exact = true) {
    const expression = `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(e=>e.getClientRects().length && ((e.getAttribute('aria-label')||e.textContent).replace(/\\s+/g,' ').trim()${exact ? "===" : ".includes("}${JSON.stringify(name)}${exact ? "" : ")"}))`
    await this.until(`!!(${expression})`, `${selector}: ${name}`)
    await this.execute(
      `document.querySelectorAll('[data-ui-target]').forEach(e=>e.removeAttribute('data-ui-target'));(${expression}).setAttribute('data-ui-target','yes');return true`
    )
    await this.click('[data-ui-target="yes"]')
  }
  async fill(selector: string, text: string) {
    const id = await this.element(selector)
    await this.request(this.route(`/element/${id}/clear`), {})
    await this.request(this.route(`/element/${id}/value`), { text })
    await Bun.sleep(100)
  }
  async hover(selector: string) {
    await this.element(selector)
    // The native driver's pointerMove emits only mousemove (no enter/leave).
    // Supply the missing DOM boundary events to exercise the real hover UI.
    await this.execute(
      `
      const next=document.querySelector(arguments[0]),old=window.__uiHovered;
      if(old){old.dispatchEvent(new MouseEvent('mouseout',{bubbles:true,relatedTarget:next}));old.dispatchEvent(new MouseEvent('mouseleave',{relatedTarget:next}));}
      const r=next.getBoundingClientRect(),options={clientX:r.x+r.width/2,clientY:r.y+r.height/2,relatedTarget:old};
      next.dispatchEvent(new MouseEvent('mouseover',{...options,bubbles:true}));
      next.dispatchEvent(new MouseEvent('mouseenter',options));window.__uiHovered=next;return true`,
      [selector]
    )
  }
  async keys(...keys: string[]) {
    if (
      keys.includes("\uE007") &&
      (keys.includes("\uE03D") || keys.includes("\uE009"))
    ) {
      // wdio-webdriver 1.4.0 drops modifiers for special keys (including Enter).
      // Supply the missing event flags to the real WebView's keyboard handlers;
      // product state and IPC still run normally, as for the hover bridge below.
      await this.execute(
        `for (let press = 0; press < arguments[2]; press++) {
          for (const type of ['keydown', 'keyup']) {
            (document.activeElement || document.body).dispatchEvent(new KeyboardEvent(type, {
              key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
              metaKey: arguments[0], ctrlKey: arguments[1], bubbles: true, cancelable: true
            }));
          }
        } return true`,
        [
          keys.includes("\uE03D"),
          keys.includes("\uE009"),
          keys.filter((key) => key === "\uE007").length,
        ]
      )
      await Bun.sleep(150)
      return
    }
    await this.request(this.route("/actions"), {
      actions: [
        {
          type: "key",
          id: "keyboard",
          actions: [
            ...keys.map((value) => ({ type: "keyDown", value })),
            ...keys.toReversed().map((value) => ({ type: "keyUp", value })),
          ],
        },
      ],
    })
    await this.request(this.route("/actions"), undefined, "DELETE")
    await Bun.sleep(150)
  }
  /** Exercise WebView keyboard handlers with the modifier flags lost by WDIO. */
  async shortcut(key: string, shift = false) {
    await this.execute(
      `const e=document.activeElement || document.body;
       for(const type of ['keydown','keyup']) e.dispatchEvent(new KeyboardEvent(type,{
         key:arguments[0],code:'Key'+arguments[0].toUpperCase(),keyCode:arguments[0].toUpperCase().charCodeAt(0),
         which:arguments[0].toUpperCase().charCodeAt(0),metaKey:true,shiftKey:arguments[1],bubbles:true,cancelable:true
       }));return true`,
      [key, shift]
    )
  }
  /** Native menus are outside the WebView; target the isolated test process. */
  async nativeMenu(menu: string, item: string) {
    assert.equal(
      process.platform,
      "darwin",
      "Native menu validation requires macOS"
    )
    assert(this.child, "Start the validation process before using its menu")
    await this.until(
      "!document.querySelector('[role=dialog], [role=alertdialog]')",
      "close dialog before native menu action"
    )
    const result = Bun.spawn(
      [
        "osascript",
        "-e",
        `on run argv
        set targetPid to (item 1 of argv) as integer
        set menuName to item 2 of argv
        set itemName to item 3 of argv
        with timeout of 12 seconds
          tell application "System Events"
            tell (first application process whose unix id is targetPid)
              set frontmost to true
              repeat 50 times
                if enabled of menu bar item menuName of menu bar 1 then exit repeat
                delay 0.1
              end repeat
              click menu bar item menuName of menu bar 1
              repeat 50 times
                if enabled of menu item itemName of menu 1 of menu bar item menuName of menu bar 1 then exit repeat
                delay 0.1
              end repeat
              click menu item itemName of menu 1 of menu bar item menuName of menu bar 1
              -- AXPress returns while Cocoa can still be tracking the menu.
              -- A subsequent WebDriver DOM click can cancel that selection.
              -- Wait for native closure, never for product state or a fixed delay.
              set menuClosed to false
              repeat 100 times
                if not (exists menu 1 of menu bar item menuName of menu bar 1) then
                  set menuClosed to true
                  exit repeat
                end if
                set menuSize to size of menu 1 of menu bar item menuName of menu bar 1
                if item 1 of menuSize is 0 and item 2 of menuSize is 0 then
                  set menuClosed to true
                  exit repeat
                end if
                delay 0.02
              end repeat
              if not menuClosed then error "Native menu did not close after selection."
            end tell
          end tell
        end timeout
      end run`,
        String(this.child.pid),
        menu,
        item,
      ],
      { stdout: "pipe", stderr: "pipe" }
    )
    const error = await new Response(result.stderr).text()
    assert.equal(
      await result.exited,
      0,
      `Cannot complete native ${menu} > ${item}. Check macOS Accessibility permission and menu completion: ${error}`
    )
  }
  async select(selector: string, label: string) {
    await this.click(selector)
    const popupId = await this.execute<string>(
      "return document.querySelector(arguments[0]).getAttribute('aria-controls')",
      [selector]
    )
    await this.named(label, `[id=${JSON.stringify(popupId)}] [role="option"]`)
    await this.until(
      `document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-expanded') === 'false'`,
      "selection committed"
    )
  }
  async harnessOption(provider: "codex" | "claude", option: string) {
    const name = provider === "codex" ? "Codex" : "Claude Code"
    await this.until(
      `document.querySelector('article[aria-label="${name} harness"] [role=status]') && !document.querySelector('article[aria-label="${name} harness"] [role=status]').textContent.includes('Checking')`,
      "harness detection complete"
    )
    await this.named(`${name} options`)
    const trigger = `[aria-label="${name} options"][aria-expanded="true"]`
    await this.until(
      `!!document.querySelector(${JSON.stringify(trigger)})`,
      `${name} menu open`
    )
    const menuId = await this.execute<string>(
      `return document.querySelector(arguments[0]).getAttribute('aria-controls')`,
      [trigger]
    )
    // A previous menu can remain mounted during its exit/focus transition.
    // Follow this trigger's accessible relationship instead of its labels alone.
    await this.named(
      option,
      `[id=${JSON.stringify(menuId)}][data-open] [role="menuitem"]`
    )
  }
  async setHarnessExecutable(provider: "codex" | "claude", path: string) {
    await this.harnessOption(provider, "Choose another exec")
    await this.fill(`[aria-label="${provider} executable"]`, path)
    await this.named("Save and detect again")
    await this.until(
      `!document.querySelector('[aria-label="${provider} executable"]')`,
      "executable saved"
    )
  }
  async setDefaultHarness(provider: "codex" | "claude") {
    await this.click("#default-provider")
    await this.named(
      provider === "codex" ? "Codex" : "Claude Code",
      '[role="option"]'
    )
    await this.until(
      `document.querySelector('#default-provider')?.textContent.includes('${provider === "codex" ? "Codex" : "Claude Code"}') && !document.querySelector('#default-provider').disabled`,
      "default harness saved"
    )
  }
  /** Enter the scope step, regardless of whether this machine needs Rev setup. */
  async reviewScope() {
    // Repository loading may finish after the Open click has returned. Wait for
    // an actionable surface before deciding whether the wizard needs opening.
    await this.until(
      `!!document.querySelector('[role="dialog"]') || [...document.querySelectorAll('button')].some(e=>e.textContent.trim()==='Start review' && !e.disabled)`,
      "review entry point"
    )
    if (
      await this.execute(
        `return !document.querySelector('[role="dialog"]') && [...document.querySelectorAll('button')].some(e=>e.textContent.trim()==='Start review')`
      )
    )
      await this.named("Start review")
    const scope = '[role="dialog"] [aria-label="Review scope"]'
    const skip =
      "[...document.querySelectorAll('[role=dialog] footer button')].find(e=>e.textContent.trim()==='Continue without Rev')"
    await this.wait(
      () =>
        this.execute(
          `return !!document.querySelector(${JSON.stringify(scope)}) || !!(${skip})`
        ),
      "new-review scope or optional harness setup",
      30000
    )
    if (await this.execute(`return !!(${skip})`))
      await this.named("Continue without Rev", "[role=dialog] footer button")
    await this.element(scope)
  }
  /** Targets the wizard footer only, never an open Git reference suggestion. */
  async nextReviewStep() {
    await this.until(
      "[...document.querySelectorAll('[role=dialog] footer button')].some(e=>e.textContent.trim()==='Next' && !e.disabled)",
      "enabled wizard Next"
    )
    await this.named("Next", "[role=dialog] footer button")
  }
  async reviewReference(
    label: "Commit" | "Base reference" | "Target reference",
    value: string
  ) {
    await this.fill(
      `[role=dialog] input[aria-label=${JSON.stringify(label)}]`,
      value
    )
    // A reference is an editable combobox. Leave its popup before interacting
    // with the scope cards/footer, just as a keyboard user would.
    await this.keys("\uE004")
  }
  /** Existing review-feature tests explicitly choose the provider-free path. */
  async startManualReview() {
    await this.reviewScope()
    await this.nextReviewStep()
    await this.element('[role=dialog] [aria-label="Review preparation"]')
    await this.named("Myself", "[role=dialog] label", false)
    await this.until(
      "[...document.querySelectorAll('[aria-label=\"Review preparation\"] label')].find(e=>e.textContent.includes('Myself'))?.querySelector('[role=radio]')?.getAttribute('aria-checked') === 'true'",
      "manual preparation selected"
    )
    await this.until(
      "[...document.querySelectorAll('[role=dialog] footer button')].some(e=>e.textContent.trim()==='Start review' && !e.disabled)",
      "enabled Start review"
    )
    await this.named("Start review", "[role=dialog] footer button")
    await this.until(
      "!document.querySelector('[role=dialog]')",
      "review capture completed"
    )
  }
  async resize(width: number, height = 900) {
    await this.request(this.route("/window/rect"), { width, height })
    await this.until(`window.innerWidth === ${width}`, "window resize")
    await Bun.sleep(250)
  }
  async layout() {
    return this.execute<{
      width: number
      clipped: string[]
      overflow: { tag: string; label: string; width: number; scroll: number }[]
    }>(`
      return {width:innerWidth,clipped:[...document.querySelectorAll('aside button,header button')].filter(e=>{
        if(!e.getClientRects().length || e.closest('[aria-hidden=true],.monaco-editor'))return false;
        const b=e.getBoundingClientRect(),p=e.closest('header,aside').getBoundingClientRect();
        return b.left<p.left-1 || b.right>p.right+1;
      }).map(e=>e.getAttribute('aria-label')||e.textContent.trim()),overflow:[...document.querySelectorAll('aside,aside *,nav,nav *,main,main > *,header,[role=dialog] *')].filter(e=>{
        if(!e.getClientRects().length || e.closest('.monaco-editor,[aria-hidden=true]') || e.matches('pre,pre *')) return false;
        const s=getComputedStyle(e);
        return e.scrollWidth>e.clientWidth+1 && ['auto','scroll'].includes(s.overflowX);
      }).map(e=>({tag:e.tagName,label:e.getAttribute('aria-label')||e.textContent.slice(0,90),width:e.clientWidth,scroll:e.scrollWidth}))}`)
  }
  async screenshot(name: string) {
    // WebKit pauses CSS animations in covered windows. Settle finite transitions
    // for a screenshot of the final layout; infinite progress indicators keep running.
    await this.execute(`for (const animation of document.getAnimations()) {
      if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.finish();
    } return true`)
    await Bun.sleep(350)
    const data = await this.request<string>(this.route("/screenshot"))
    await writeFile(
      join(this.artifacts, `${name}.png`),
      Buffer.from(data, "base64")
    )
    await writeFile(join(this.artifacts, `${name}.txt`), await this.text())
    await writeFile(
      join(this.artifacts, `${name}.errors.json`),
      JSON.stringify(
        await this.execute("return window.__uiErrors ?? []"),
        null,
        2
      )
    )
  }
  async stop() {
    if (this.session)
      await this.request(this.route(""), undefined, "DELETE").catch(() => {})
    this.child?.kill()
    await this.child?.exited
  }
}

export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "reviewbox-ui-"))
  const repo = join(root, "sample-project")
  await mkdir(join(repo, "src"), { recursive: true })
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: repo })
    assert.equal(result.exitCode, 0, result.stderr.toString())
    return result.stdout.toString()
  }
  git("init", "-q", "-b", "main")
  git("config", "user.name", "UI fixture")
  git("config", "user.email", "fixture@example.invalid")
  git("config", "commit.gpgsign", "false")
  const write = (path: string, content: string) =>
    writeFile(join(repo, path), content)
  await write("src/answer.ts", "export const answer = 41;\n")
  await write("src/other.ts", "export const other = 'before';\n")
  await write("README.md", "# Sample\nA project for review.\n")
  await write(
    "package.json",
    '{"name":"reviewbox-fixture","scripts":{"test":"bun test"}}\n'
  )
  await write(
    "answer.test.ts",
    'import {test,expect} from "bun:test";test("answer",()=>expect(42).toBe(42));\n'
  )
  git("add", ".")
  git("commit", "-qm", "Initial files")
  await write("README.md", "# Sample\nA project for review and explanations.\n")
  git("add", ".")
  git("commit", "-qm", "Describe review context")
  await write("src/answer.ts", "export const answer = 42;\n")
  git("add", "src/answer.ts")
  await write("src/answer.ts", "export const answer = 43;\n")
  await write("src/other.ts", "export const other = 'after';\n")
  await write("src/new.ts", "export const newValue = true;\n")
  const index = git("write-tree")
  return {
    root,
    repo,
    git,
    write,
    index,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}
