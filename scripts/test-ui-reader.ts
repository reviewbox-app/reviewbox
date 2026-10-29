import assert from "node:assert/strict"
import { readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { NativeUI, fixture } from "../tests/native/ui-driver"
import { createPreparationHarness } from "../tests/native/preparation-fixture"

const completionOnly = process.argv.includes("--completion-only")
const referencesOnly = process.argv.includes("--references-only")
const f = await fixture()
const ui = new NativeUI()
const harness = await createPreparationHarness(f.root, false, 11, true)
await writeFile(harness.mode, "done")
await writeFile(join(f.repo, "binary.dat"), Buffer.from([0, 1, 255, 0]))
if (referencesOnly) {
  const base =
    Array.from(
      { length: 160 },
      (_, i) => `export const line${i + 1} = ${i + 1};`
    ).join("\n") + "\n"
  await f.write("src/answer.ts", base)
  f.git("add", "src/answer.ts")
  f.git("commit", "--only", "src/answer.ts", "-m", "Reference fixture")
  await f.write(
    "src/answer.ts",
    base
      .replace("line40 = 40", "line40 = 400")
      .replace("export const line60 = 60;\n", "")
  )
  f.git("add", "src/answer.ts")
  await f.write(
    "src/answer.ts",
    base
      .replace("line40 = 40", "line40 = 400")
      .replace("line120 = 120", "line120 = 1200")
      .replace("export const line60 = 60;\n", "")
  )
  await writeFile(
    harness.executable,
    (await readFile(harness.executable, "utf8"))
      .replace(
        "startLine:1,endLine:1",
        "startLine:source.path.endsWith('answer.ts')?80:1,endLine:source.path.endsWith('answer.ts')?82:1"
      )
      .replace(
        " results.push({id:work.id,result});",
        `
      if(kind==='readingStep' && input.sources.some(s=>s.path.endsWith('answer.ts'))) {
        for(const doc of Object.values(result)) {
          const before={id:'previous',label:'previous value',explanation:'The previous captured version.',sourceId:input.sources.find(s=>s.sourceId.endsWith(':before')).sourceId,startLine:80,endLine:82};
          const context={id:'context',label:'context value',explanation:'The full captured context file.',sourceId:'file:src/answer.ts',startLine:80,endLine:82};
          const deleted={...before,id:'changed-before',label:'changed before',startLine:40,endLine:40};
          const removed={...before,id:'deleted-before',label:'deleted before',startLine:60,endLine:60};
          const tall={...context,id:'long-range',label:'long range',startLine:75,endLine:140};
          doc.references.push(before,context,deleted,removed,tall);
          if(doc===result.technical) {
            const illustration='<button onclick="window.reviewboxIllustration.openReference(\\\'context\\\')">Explore context</button><script>addEventListener("message",e=>{if(e.data==="open-reference-fixture")window.reviewboxIllustration.openReference("context")})</script>';
            doc.body+='\\n\\n'+String.fromCharCode(96).repeat(3)+'source\\ncontext\\n'+String.fromCharCode(96).repeat(3)+'\\n\\n'+String.fromCharCode(96).repeat(3)+'html\\n'+illustration+'\\n'+String.fromCharCode(96).repeat(3);
          }
          doc.body+='\\n\\n[previous value](reviewbox:ref/previous) and [context value](reviewbox:ref/context) and [changed before](reviewbox:ref/changed-before) and [deleted before](reviewbox:ref/deleted-before) and [long range](reviewbox:ref/long-range)';
        }
      }
      results.push({id:work.id,result});`
      )
  )
}

async function verifyReferences() {
  await ui.named("Explained", '[aria-label="Reading mode"] [role="tab"]')
  const open = async (name: string) => {
    await ui.named("Document", '[role="tab"]')
    await ui.named(name, "main[aria-label=Review] article button")
    await ui.until('!!document.querySelector("[data-slot=hover-card-content]")')
    assert(
      !(await ui.execute(
        'return !!document.querySelector("[data-slot=hover-card-content] pre")'
      ))
    )
    await ui.named("Open in code", "[data-slot=hover-card-content] button")
    if (["previous value", "changed before", "deleted before"].includes(name))
      await ui.until(
        `!!document.querySelector('[aria-label="Code diff"]:not([aria-hidden=true] *) [aria-label="Hide previous code"]')`
      )
  }
  const centered = async (name: string) => {
    await ui.until(
      `(() => {
      const root=document.querySelector('[aria-label="Referenced source"]') ?? [...document.querySelectorAll('[aria-label="Code diff"]')].at(-1);
      const marks=[...root.querySelectorAll('.view-overlays .review-passage')].map(e=>e.getBoundingClientRect()).filter(r=>r.height>0 && r.width>0);
      if(!marks.length)return false;
      const rect=root.getBoundingClientRect(), center=(rect.top+112+rect.bottom-100)/2;
      return ${name === "long range" ? "[marks[0]]" : "marks"}.some(r=>Math.abs((r.top+r.bottom)/2-center)<80);
    })()`,
      "referenced range centered"
    )
    assert.equal(
      await ui.execute(
        'return document.querySelectorAll(".diff-hidden-lines").length'
      ),
      0
    )
    await ui.has("Step 1 of 11")
  }
  for (const name of [
    "value",
    "previous value",
    "changed before",
    "deleted before",
    "context value",
    "long range",
  ]) {
    await open(name)
    await centered(name)
    if (name !== "context value" && name !== "long range") {
      for (const layout of ["Show previous code", "Hide previous code"]) {
        if (
          await ui.execute(
            `return !!document.querySelector('[aria-label="${layout}"]')`
          )
        )
          await ui.named(layout)
        // Explicit navigation, not layout changes, owns centering.
        await open(name)
        await centered(name)
      }
    }
    const viewport =
      '[aria-label="Referenced source"] .monaco-scrollable-element, [aria-label="Code diff"] .block-diff-main .monaco-scrollable-element'
    await ui.execute(
      `const nodes=[...document.querySelectorAll(arguments[0])];nodes.at(-1).dispatchEvent(new WheelEvent('wheel',{deltaY:400,bubbles:true,cancelable:true}));return true`,
      [viewport]
    )
    await open(name)
    await centered(name)
    await ui.screenshot(`reference-${name.replaceAll(" ", "-")}`)
  }
  await ui.named("Document", '[role="tab"]')
  await ui.named("Technical", '[aria-label="Reading mode"] [role="tab"]')
  await ui.execute(
    `const card=[...document.querySelectorAll('main[aria-label=Review] article section')].find(e=>e.querySelector('p')?.textContent==='context value');card.scrollIntoView({block:'center'});card.querySelector('button').click();return true`
  )
  await centered("context value")
  await ui.named("Document", '[role="tab"]')
  await ui.execute(
    `const scroller=document.querySelector('[aria-label="Review document"]');scroller.scrollTop=scroller.scrollHeight;return true`
  )
  await ui.until(
    "!!document.querySelector('main[aria-label=Review] article iframe')"
  )
  await ui.wait(async () => {
    await ui.execute(
      `document.querySelector('main[aria-label=Review] article iframe').contentWindow.postMessage('open-reference-fixture','*');return true`
    )
    return ui.execute(
      `return document.querySelector('[role="tab"][aria-label="Code"]')?.getAttribute('aria-selected')==='true'`
    )
  }, "illustration reference bridge")
  await centered("context value")
  await ui.named("Close pinned reference")
  await ui.has("Validate step and continue")
  assert.deepEqual(await ui.execute("return window.__uiErrors"), [])
}
async function level(name: string) {
  let returnToCode = false
  if (
    !(await ui.execute(
      `return !!document.querySelector('[aria-label="Reading mode"]')`
    ))
  ) {
    returnToCode = await ui.execute<boolean>(
      `return document.querySelector('[role="tab"][aria-label="Code"]')?.getAttribute("aria-selected") === "true"`
    )
    await ui.named("Document", '[role="tab"]')
  }
  await ui.named(name, '[aria-label="Reading mode"] [role="tab"]')
  await ui.until(
    `document.querySelector('[aria-label="Reading mode"] [aria-selected="true"]')?.textContent.includes(${JSON.stringify(name)})`
  )
  if (returnToCode) await ui.named("Code", '[role="tab"]')
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
async function resizeExplanation() {
  const selector = '[role="separator"][aria-label="Resize explanation"]'
  await ui.element(selector)
  const measure = () =>
    ui.execute<number>(
      'return document.querySelector("aside[aria-label=Explanation]").getBoundingClientRect().width'
    )
  const initial = await measure()
  await ui.execute(
    'window.__readerEditor = document.querySelector(".monaco-editor"); return true'
  )
  const drag = (distance: number) =>
    ui.execute(
      `
    const handle = document.querySelector(arguments[0]), rect = handle.getBoundingClientRect();
    const capture = handle.setPointerCapture, release = handle.releasePointerCapture;
    handle.setPointerCapture = () => {}; handle.releasePointerCapture = () => {};
    try {
      for (const [type, x] of [["pointerdown", rect.x], ["pointermove", rect.x + arguments[1]], ["pointerup", rect.x + arguments[1]]])
        handle.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, clientX: x, clientY: rect.y + 200 }));
    } finally { handle.setPointerCapture = capture; handle.releasePointerCapture = release; }
    return true`,
      [selector, distance]
    )
  const key = (key: string) =>
    ui.execute(
      'document.querySelector(arguments[0]).dispatchEvent(new KeyboardEvent("keydown", { key: arguments[1], bubbles: true, cancelable: true })); return true',
      [selector, key]
    )
  await drag(-80)
  assert(
    Math.abs((await measure()) - initial - 80) < 2,
    "dragging left widens the right panel"
  )
  await key("ArrowRight")
  const remembered = await measure()
  assert(
    Math.abs(remembered - initial - 70) < 2,
    "right arrow moves the divider right"
  )
  await ui.named("Explanation")
  await ui.named("Explanation")
  assert(
    Math.abs((await measure()) - remembered) < 2,
    "explanation width survives reopening"
  )
  assert(
    await ui.execute(`
    const panel = document.querySelector("aside[aria-label=Explanation]");
    const handle = panel.querySelector('[role="separator"]');
    const before = handle.getBoundingClientRect().top;
    panel.querySelector(":scope > .overflow-y-auto").scrollTop = 300;
    return handle.getBoundingClientRect().top === before && window.__readerEditor === document.querySelector(".monaco-editor");
  `),
    "scrolling leaves the handle fixed and resizing preserves the editor"
  )
  await key("Home")
  assert.equal(await measure(), 280)
  await key("End")
  const wide = await measure()
  await ui.resize(800, 900)
  assert(
    (await measure()) < wide && (await measure()) <= 400,
    "right panel is bounded in narrow windows"
  )
  await ui.resize(1440, 900)
  assert(Math.abs((await measure()) - wide) < 2)
  await drag(wide - initial)
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
  if (completionOnly) {
    for (let step = 1; step <= 11; step++) {
      await ui.has(`Step ${step} of 11`)
      await ui.named("Validate step and continue")
    }
    await ui.has("Review complete")
    await ui.has("11 of 11 steps validated")
    await ui.has("Published in the repository.")
    const published = await readdir(join(f.repo, ".reviewbox", "published"))
    assert.equal(published.length, 1, "last step publishes exactly once")
    const completed = JSON.parse(
      await readFile(
        join(
          f.repo,
          ".reviewbox",
          "published",
          published[0],
          "reviews",
          published[0],
          "review.json"
        ),
        "utf8"
      )
    )
    assert.equal(completed.data.publication.status, "published")
    assert.equal(completed.data.publication.completion.kind, "guided")
    assert.equal(
      f.git("write-tree"),
      f.index,
      "publication preserves the index"
    )
    await ui.named("Back to review")
    await ui.named("Review summary")
    await ui.has("11 of 11 steps validated")
    await ui.named("Back home", "main[aria-label=Review] button")
    await ui.named("Review", '[role="tab"]')
    await ui.has("Review complete")
    await ui.screenshot("reader-guided-published")
    console.log(
      "Native completion: eleven steps validated, published once, summary reopened and resumed, Git index preserved."
    )
  } else if (referencesOnly) {
    await verifyReferences()
    console.log(
      "Native references: cards without snippets, exact before/after/context sources, repeated centered navigation, complete Unified/Split files and preserved step passed."
    )
  } else {
    await ui.element('[aria-label="Review steps"]')
    assert.equal(
      await ui.execute(
        'return document.querySelectorAll("[aria-label=\\"Review steps\\"] > li").length'
      ),
      11
    )
    assert(!(await ui.text()).includes("Not explained by Rev"))
    await ui.keys("\uE00C")

    await level("Essential")
    assert.equal(
      await ui.execute(
        'return !!document.querySelector("[role=tab][aria-label=Code]")'
      ),
      true,
      "Essential permits the same code views"
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
    for (const name of ["Essential", "Explained", "Technical"]) {
      await level(name)
      await ui.named("Code", '[role="tab"]')
      await ui.until(
        '[...document.querySelectorAll("[aria-label=\\"Code diff\\"] .view-lines")].some(e => e.textContent.includes("export"))'
      )
      await ui.named("Document", '[role="tab"]')
    }
    await level("Explained")
    await ui.execute(
      'document.querySelector("[aria-label=\\"Review document\\"]").scrollTop=0;return true'
    )
    await ui.named("value", "main[aria-label=Review] article button")
    await ui.until('!!document.querySelector("[data-slot=hover-card-content]")')
    const referenceCard = await ui.execute<string>(
      'return document.querySelector("[data-slot=hover-card-content]").textContent'
    )
    assert(referenceCard.includes("Open in code"))
    assert(!referenceCard.includes("export const"))
    assert(
      !(await ui.execute('return !!document.querySelector("[role=dialog]")'))
    )
    await ui.named("Open in code", "[data-slot=hover-card-content] button")
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

    await level("Technical")
    await ui.named("Code", "[role=tab]")
    assert(
      (await ui.execute<string>(
        `return document.querySelector('[role="tab"][aria-label="Code"]').textContent.trim()`
      )) === "Code",
      "changing reading mode keeps source code visible"
    )
    await ui.until(
      '[...document.querySelectorAll("[aria-label=\\"Code diff\\"] .view-lines")].some(e => e.textContent.includes("export"))'
    )
    for (const layout of ["Show previous code", "Hide previous code"]) {
      await ui.named(layout)
      assert.equal(
        await ui.execute(
          'return document.querySelectorAll(".diff-hidden-lines").length'
        ),
        0,
        "unchanged lines remain visible"
      )
    }
    await resizeExplanation()
    for (const name of ["Dark", "Light"]) {
      await theme(name)
      for (const width of [1440, 800]) {
        await ui.resize(width, 900)
        await ui.execute(
          'document.querySelector(".block-diff-main .monaco-scrollable-element").dispatchEvent(new WheelEvent("wheel",{deltaY:220,bubbles:true,cancelable:true}));return true'
        )
        assert.deepEqual((await ui.layout()).overflow, [])
        await ui.screenshot(`reader-code-${name.toLowerCase()}-${width}`)
      }
    }
    await ui.resize(1440, 900)
    await ui.named("Files")
    assert.equal(
      await ui.execute(
        'return document.querySelectorAll("[aria-label=\\"Review files\\"] [aria-expanded=false]").length'
      ),
      0,
      "Review folders cannot be collapsed"
    )
    assert.equal(
      await ui.execute(
        'return document.querySelectorAll("[aria-label=\\"Review files\\"] button[title]").length'
      ),
      4,
      "one row per path despite staged and unstaged"
    )
    assert(
      await ui.execute(
        'return !!document.querySelector("[aria-label=\\"Review files\\"] [data-git-status=U]") && !!document.querySelector("[aria-label=\\"Review files\\"] [data-git-status=M]")'
      ),
      "captured Git letters are visible"
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
    await level("Explained")
    await ui.named("binary.dat", '[aria-label="Review files"] button', false)
    assert(
      !(await ui.execute(
        'return [...document.querySelectorAll("button")].find(e=>e.textContent.trim()==="Validate file and continue").disabled'
      )),
      "validation does not require generated translations"
    )
    await level("Essential")
    await ui.named("Code", '[role="tab"]')
    assert(
      await ui.execute(
        'return document.querySelector("[aria-label=\\"Review files\\"] [aria-current=page]").getAttribute("title") === "binary.dat"'
      ),
      "changing reading mode keeps the selected file"
    )
    assert(
      !(await ui.execute(
        'return [...document.querySelectorAll("button")].find(e=>e.textContent.trim()==="Validate file and continue").disabled'
      )),
      "Essential may review captured binary metadata in source view"
    )
    const selectedFile = await ui.execute<string>(
      'return document.querySelector("[aria-label=\\"Review files\\"] [aria-current=page]").getAttribute("title")'
    )
    await ui.named("Validate file and continue")
    await ui.until(
      `document.querySelector('[aria-label="Review files"] [aria-current="page"]').getAttribute('title') !== ${JSON.stringify(selectedFile)}`
    )
    await ui.named("Contents")
    await ui.named(
      "The other value",
      '[aria-label="Review steps"] button',
      false
    )
    await ui.has("Step 2 of 11")
    for (let step = 2; step <= 11; step++) {
      await ui.has(`Step ${step} of 11`)
      await ui.named("Validate step and continue")
    }
    await ui.has("Review complete")
    await ui.has("11 of 11 steps validated")
    await ui.has("Guided review: all authored steps were validated.")
    await ui.has("Published in the repository.")
    const published = await readdir(join(f.repo, ".reviewbox", "published"))
    assert.equal(
      published.length,
      1,
      "the final guided decision publishes once"
    )
    const completed = JSON.parse(
      await readFile(
        join(
          f.repo,
          ".reviewbox",
          "published",
          published[0],
          "reviews",
          published[0],
          "review.json"
        ),
        "utf8"
      )
    )
    assert.equal(completed.data.publication.status, "published")
    assert.equal(completed.data.publication.completion.kind, "guided")
    assert.equal(
      f.git("write-tree"),
      f.index,
      "automatic publication never stages"
    )
    await ui.named("Back to review")
    await ui.named("Review summary")
    await ui.has("Review complete")
    await ui.has("11 of 11 steps validated")
    await ui.screenshot("reader-guided-published")
    await ui.named("Back home", "main[aria-label=Review] button")
    await ui.has("Complete")

    await ui.named("Review", '[role="tab"]')
    if ((await ui.text()).includes("Back to review"))
      await ui.named("Back to review")
    await ui.until(
      '!document.querySelector("main[aria-label=Review] > footer")'
    )
    await f.write("src/answer.ts", "export const answer = 99;\n")
    // The automation can cover the WebView; simulate a foreground focus event
    // so the production visibility guard actually runs its source check.
    await ui.execute(
      `Object.defineProperty(document, 'visibilityState', {configurable:true,get:()=> 'visible'});window.dispatchEvent(new Event('focus'));return true`
    )
    await ui.wait(
      async () => (await ui.text()).includes("Update with Rev"),
      "external source change",
      45000
    )
    // A published review keeps its authored tour and exact sources. Updating it
    // now uses the dedicated adaptation pipeline, rather than clearing its steps.
    await ui.has("Step 11 of 11")
    await ui.until(
      '[...document.querySelectorAll("[aria-label=\\"Code diff\\"] .view-lines")].some(e => e.textContent.includes("42"))'
    )
    await ui.until(
      '!document.querySelector("main[aria-label=Review] > footer")'
    )
    await ui.screenshot("reader-changed-published-without-footer")

    await ui.keys("\uE03D", "n")
    await ui.startManualReview()
    await ui.until(
      '!document.querySelector("main[aria-label=Review] > footer")'
    )
    assert.equal(
      await ui.execute(
        `return !!document.querySelector('[aria-label="Reading mode"], button[aria-label="Explanation"]')`
      ),
      false,
      "manual reviews hide reading levels and explanation controls"
    )
    assert.equal(
      await ui.execute(
        'return !!document.querySelector("aside[aria-label=Explanation]")'
      ),
      false,
      "files without documents hide the explanation panel"
    )
    await ui.named("Document", "[role=tab]")
    await ui.has("Explore the captured file")
    assert(
      await ui.execute(
        'return !document.querySelector("main[aria-label=Review] > footer")'
      ),
      "reviews without steps have no decision footer"
    )
    await ui.request(ui.route("/window"), { handle: "settings" })
    await ui.named("Reading", "nav button")
    await ui.until(
      `document.querySelector('[aria-label="Reading mode"] [role="radio"][aria-checked="true"]')?.closest("label").textContent.includes("Explained")`
    )
    await ui.named("Technical", '[aria-label="Reading mode"] label', false)
    await ui.until(
      `document.querySelector('[aria-label="Reading mode"] [role="radio"][aria-checked="true"]')?.closest("label").textContent.includes("Technical")`
    )
    await ui.named("Explained", '[aria-label="Reading mode"] label', false)
    await ui.until(
      `document.querySelector('[aria-label="Reading mode"] [role="radio"][aria-checked="true"]')?.closest("label").textContent.includes("Explained")`
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
      `document.querySelector('[role="dialog"] [aria-label="Reading mode"] [role="radio"][aria-checked="true"]')?.closest("label").textContent.includes("Explained")`
    )
    await ui.named(
      "Essential",
      '[role="dialog"] [aria-label="Reading mode"] label',
      false
    )
    await ui.until(
      `document.querySelector('[role="dialog"] [aria-label="Reading mode"] [role="radio"][aria-checked="true"]')?.closest("label").textContent.includes("Essential")`
    )
    await ui.named("Close new review")
    assert.deepEqual(await ui.execute("return window.__uiErrors"), [])
    assert.equal(f.git("write-tree"), f.index)
    console.log(
      "Native reader: eleven guided steps, three levels, source references, independent file decisions, atomic validation and next, summary, complete captured source, glass surfaces passed."
    )
  }
} catch (error) {
  console.error(await ui.text().catch(() => "No UI"))
  await ui.screenshot("reader-failure").catch(() => {})
  throw error
} finally {
  await ui.stop()
  await f.cleanup()
}
