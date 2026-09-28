import assert from "node:assert/strict"
import { NativeUI, fixture } from "../tests/native/ui-driver"

// Build with REVIEWBOX_DEVTOOLS=1 bun run build:native-validation.
const f = await fixture()
const ui = new NativeUI()
const slot = (name: string) => `[data-slot="${name}"]`
const results: unknown[] = []

async function settle() {
  await ui.execute(`for (const animation of document.getAnimations()) {
    if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.finish();
  } return true`)
}

async function close(name: string) {
  if (name === "alert-dialog-content")
    await ui.named("Cancel", '[role="alertdialog"] button')
  else if (name === "menubar-content")
    await ui.named("Passage 60", `${slot(name)} [role="menuitem"]`)
  else await ui.keys("\uE00C")
  await settle()
  await ui.until(
    `!document.querySelector(${JSON.stringify(`${slot(name)}[data-open]`)})`,
    `${name} closes`
  )
}

async function checkScroll(name: string, scroller = name) {
  const selector = slot(name)
  await ui.until(`!!document.querySelector(${JSON.stringify(selector)})`)
  await settle()
  const before = await ui.execute<{
    filter: string
    top: number
    height: number
    width: number
  }>(
    `
    const surface = document.querySelector(arguments[0]);
    const r = surface.getBoundingClientRect();
    const style = getComputedStyle(surface);
    return {filter: style.backdropFilter || style.webkitBackdropFilter,
      top:r.top, height:r.height, width:r.width};`,
    [selector]
  )
  assert.match(
    before.filter,
    /blur\(/,
    `${name} has a non-scrolling blur surface`
  )
  assert(
    await ui.execute(
      `return !document.querySelector(arguments[0]).closest('[data-testid="overlay-triggers"]')`,
      [selector]
    ),
    `${name} escapes the triggering scroll container`
  )
  const amount = await ui.execute<number>(
    `
    const scroller = document.querySelector(arguments[0]);
    scroller.scrollTop = scroller.scrollHeight;
    return scroller.scrollTop;`,
    [slot(scroller)]
  )
  assert(amount > 100, `${scroller} genuinely scrolls`)
  const after = await ui.execute<{
    filter: string
    top: number
    height: number
    width: number
  }>(
    `
    const surface = document.querySelector(arguments[0]), r = surface.getBoundingClientRect();
    const style = getComputedStyle(surface);
    return {filter:style.backdropFilter || style.webkitBackdropFilter,top:r.top,height:r.height,width:r.width};`,
    [selector]
  )
  assert.deepEqual(
    after,
    before,
    `${name} surface stays fixed during content scrolling`
  )
  const coverage = await ui.execute<boolean>(
    `
    const surface = document.querySelector(arguments[0]), r = surface.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.bottom - 12);
    return hit === surface || surface.contains(hit);`,
    [selector]
  )
  assert(coverage, `${name} remains interactive at its bottom edge`)
  results.push({ name, before, scrollTop: amount })
  console.log(`Passed ${name}: scroll ${amount}px`)
}

async function checkBackdrop(name: string) {
  assert(
    await ui.execute(
      `
    const node=document.querySelector(arguments[0]),r=node.getBoundingClientRect();
    return getComputedStyle(node).position === 'fixed' && r.top <= 0 && r.left <= 0 && r.right >= innerWidth && r.bottom >= innerHeight;`,
      [slot(name)]
    ),
    `${name} covers the native viewport`
  )
}

try {
  await ui.start(`${f.root}/appdata`)
  await ui.request(ui.route("/url"), {
    url: "tauri://localhost/dev/overlays/index.html",
  })
  await ui.has("Overlay scroll validation")
  await ui.execute(
    "window.BASE_UI_ANIMATIONS_DISABLED=true;window.__overlayErrors=[];addEventListener('error',e=>window.__overlayErrors.push(e.message));return true"
  )
  // Covered macOS WebViews suspend frames used by Base UI's focus/teardown.
  // Keep the same driver workaround as the native model-selector suite.
  await ui.execute(`
    const style=document.createElement('style');
    style.textContent='*,*::before,*::after{animation:none!important;transition:none!important}';
    document.head.append(style);
    const frame=requestAnimationFrame.bind(window), cancel=cancelAnimationFrame.bind(window);
    window.requestAnimationFrame=callback=>document.hidden ? -setTimeout(()=>callback(performance.now()),16) : frame(callback);
    window.cancelAnimationFrame=id=>id<0 ? clearTimeout(-id) : cancel(id);
    return true;
  `)

  for (const [theme, width] of [
    ["Light", 1440],
    ["Dark", 800],
  ] as const) {
    await ui.resize(width, 900)
    await ui.named(theme)
    await ui.until(
      `document.documentElement.classList.contains('${theme.toLowerCase()}')`
    )
    await ui.named("Dialog")
    await ui.named("Nested popover")
    await checkScroll("popover-content")
    await ui.screenshot(`overlays-${theme}-nested`)
    if (process.argv.includes("--inspect") && theme === "Light")
      await Bun.sleep(45000)
    await close("popover-content")
    await ui.fill('[role="dialog"] [role="combobox"]', "Passage")
    await checkScroll("combobox-content", "combobox-list")
    await ui.screenshot(`overlays-${theme}-nested-combobox`)
    await close("combobox-content")
    await ui.screenshot(`overlays-${theme}-dialog-before`)
    await checkScroll("dialog-content")
    await checkBackdrop("dialog-overlay")
    await ui.screenshot(`overlays-${theme}-dialog-after`)
    await close("dialog-content")

    for (const [trigger, surface, backdrop] of [
      ["Alert dialog", "alert-dialog-content", "alert-dialog-overlay"],
      ["Sheet", "sheet-content", "sheet-overlay"],
      ["Popover", "popover-content", undefined],
    ] as const) {
      await ui.named(trigger)
      await checkScroll(surface)
      if (backdrop) await checkBackdrop(backdrop)
      await ui.screenshot(`overlays-${theme}-${surface}`)
      await close(surface)
    }

    for (const [trigger, surface, subTrigger, subSurface] of [
      [
        "Dropdown",
        "dropdown-menu-content",
        "More passages",
        "dropdown-menu-sub-content",
      ],
      ["Menubar", "menubar-content", "More menu items", "menubar-sub-content"],
      [
        "Context menu",
        "context-menu-content",
        "More context",
        "context-menu-sub-content",
      ],
    ] as const) {
      if (trigger === "Context menu") {
        await ui.execute(
          `const el=document.querySelector('[data-slot="context-menu-trigger"]'),r=el.getBoundingClientRect();el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:r.x+10,clientY:r.y+10}));return true`
        )
      } else await ui.named(trigger)
      await ui.named(subTrigger, '[role="menuitem"]')
      await checkScroll(subSurface)
      await close(subSurface)
      await checkScroll(surface)
      await ui.screenshot(`overlays-${theme}-${surface}`)
      await close(surface)
    }

    await ui.click('[aria-label="Select passage"]')
    await checkScroll("select-content")
    await ui.screenshot(`overlays-${theme}-select`)
    await close("select-content")
    await ui.fill(
      '[data-testid="overlay-triggers"] input[role="combobox"]',
      "Passage"
    )
    await checkScroll("combobox-content", "combobox-list")
    await close("combobox-content")
    await ui.hover(slot("hover-card-trigger"))
    await checkScroll("hover-card-content")
    await ui.screenshot(`overlays-${theme}-hover-card`)
    await ui.hover("h1")
    await ui.until(`!document.querySelector('${slot("hover-card-content")}')`)

    await ui.named("Drawer")
    await settle()
    await ui.execute(
      `document.querySelector('[data-slot="drawer-content"] > div').scrollTop=1000;return true`
    )
    await checkBackdrop("drawer-overlay")
    await close("drawer-popup")
    await ui.named("Toast")
    await settle()
    assert.match(
      await ui.execute<string>(
        `return getComputedStyle(document.querySelector('[data-slot="toast"]')).backdropFilter`
      ),
      /blur\(/
    )
    await ui.screenshot(`overlays-${theme}-toast`)
    await ui.click(slot("toast-close"))
  }
  assert.deepEqual(await ui.execute("return window.__overlayErrors"), [])
  await ui.request(ui.route("/url"), {
    url: "tauri://localhost/settings/index.html",
  })
  await ui.until("!!document.querySelector('[data-slot=\"dialog-content\"]')")
  assert.equal(
    await ui.execute<string>(
      "return getComputedStyle(document.querySelector('[data-slot=\"dialog-content\"]')).backdropFilter"
    ),
    "none",
    "standalone settings keep their opaque surface"
  )
  await Bun.write(
    `${ui.artifacts}/overlay-results.json`,
    JSON.stringify(results, null, 2)
  )
  console.log(
    "Native overlays: scrolling, full-surface blur, portals, nested popups, submenus and viewport backdrops passed in light/wide and dark/narrow windows"
  )
} catch (error) {
  await ui.screenshot("overlays-failure").catch(() => {})
  console.error(
    await ui
      .execute(
        `return {hidden:document.hidden,focus:document.activeElement?.outerHTML.slice(0, 250),
    surfaces:[...document.querySelectorAll('[data-slot$="-content"]')].map(e=>({slot:e.dataset.slot,open:e.hasAttribute('data-open'),closed:e.hasAttribute('data-closed')}))}`
      )
      .catch(() => null)
  )
  console.error(await ui.text().catch(() => ""))
  throw error
} finally {
  await ui.stop()
  await f.cleanup()
}
