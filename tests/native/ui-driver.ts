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
    this.session = (
      await this.request<{ sessionId: string }>("/session", {
        capabilities: { alwaysMatch: { browserName: "tauri" } },
      })
    ).sessionId
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
    const id = await this.element(selector)
    await this.request(this.route(`/element/${id}/click`), {})
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
