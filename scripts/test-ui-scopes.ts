import assert from "node:assert/strict"
import { readdir } from "node:fs/promises"
import { NativeUI, fixture } from "../tests/native/ui-driver"
const f = await fixture()
const ui = new NativeUI()
try {
  await ui.start(`${f.root}/appdata`)
  await ui.named("or enter a path")
  await ui.fill('[aria-label="Repository path"]', f.root)
  await ui.named("Open")
  await ui.until("!!document.querySelector('[role=alert]')")
  await ui.fill('[aria-label="Repository path"]', f.repo)
  await ui.named("Open")
  await ui.reviewScope()
  assert.equal(
    await ui.execute(
      "return document.querySelector('[role=dialog] [role=checkbox]')?.getAttribute('aria-checked')"
    ),
    "false",
    "exclude untracked is unchecked by default"
  )
  await ui.named("A commit", "[role=dialog] label", false)
  await ui.reviewReference("Commit", "no-such-reviewbox-ref")
  await ui.until("!!document.querySelector('[role=dialog] [role=alert]')")
  assert(
    await ui.execute(
      "return !!document.querySelector('[role=dialog] [role=alert]')"
    ),
    "Reference errors must be visible inside the wizard before capture"
  )
  assert(
    await ui.execute(
      "return [...document.querySelectorAll('[role=dialog] footer button')].find(e=>e.textContent.trim()==='Next')?.disabled"
    ),
    "An invalid reference blocks Next"
  )
  assert.deepEqual(
    await readdir(`${f.repo}/.reviewbox/reviews`).catch(() => [] as string[]),
    [],
    "An invalid preview must not create a review"
  )
  const scopes = [
    { label: "Staged changes", layers: ["staged"], count: 1 },
    { label: "Unstaged changes", layers: ["unstaged"], count: 3 },
    { label: "A commit", layers: ["committed"], count: 1 },
    { label: "A range of commits", layers: ["committed"], count: 1 },
    { label: "Local changes", layers: ["staged", "unstaged"], count: 4 },
    {
      label: "Local changes",
      layers: ["staged", "unstaged"],
      count: 3,
      exclude: true,
    },
    {
      label: "Unstaged changes",
      layers: ["unstaged"],
      count: 2,
      exclude: true,
    },
  ]
  for (const [index, scope] of scopes.entries()) {
    if (index) {
      await ui.keys("\uE03D", "n")
      await ui.has("New review")
    }
    await ui.reviewScope()
    await ui.named(scope.label, "[role=dialog] label", false)
    if (scope.label === "A commit") await ui.reviewReference("Commit", "HEAD")
    if (scope.label === "A range of commits") {
      await ui.reviewReference("Base reference", "HEAD~1")
      await ui.reviewReference("Target reference", "HEAD")
    }
    if (scope.label === "Local changes" || scope.label === "Unstaged changes") {
      const checked = await ui.execute(
        "return document.querySelector('[role=dialog] [role=checkbox]')?.getAttribute('aria-checked')"
      )
      if ((checked === "true") !== (scope.exclude === true))
        await ui.named("Exclude untracked files", "[role=dialog] label", false)
    }
    const before = await readdir(`${f.repo}/.reviewbox/reviews`).catch(
      () => [] as string[]
    )
    await ui.startManualReview()
    await ui.until("!document.querySelector('[role=dialog]')")
    await ui.until("!!document.querySelector('[aria-label=\"Code diff\"]')")
    const id = (await readdir(`${f.repo}/.reviewbox/reviews`)).find(
      (id) => !before.includes(id)
    )!
    const review = await Bun.file(
      `${f.repo}/.reviewbox/reviews/${id}/review.json`
    ).json()
    const snapshot = await Bun.file(
      `${f.repo}/.reviewbox/snapshots/${review.data.snapshotId}.json`
    ).json()
    assert.equal(snapshot.data.changes.length, scope.count)
    assert.deepEqual(
      [
        ...new Set(
          snapshot.data.changes.map((c: { layer: string }) => c.layer)
        ),
      ].sort(),
      [...scope.layers].sort()
    )
    console.log(`UI capture: ${scope.label}`)
  }
  await ui.named("Split", "[role=tab]")
  await ui.until("!!document.querySelector('.monaco-diff-editor.side-by-side')")
  await ui.named("Unified", "[role=tab]")
  await ui.named("Home", "[role=tab]")
  await ui.named("Review actions")
  await ui.named("Delete review…", "[role=menuitem]")
  await ui.named("Delete review", "[role=alertdialog] button")
  await ui.until("!document.querySelector('[role=alertdialog]')")
  await ui.named("Review", "[role=tab]")
  await ui.has("Start a review")
  assert.equal(f.git("write-tree"), f.index)
  console.log(
    "Invalid path/ref, all capture scopes, split/unified and active review deletion passed"
  )
} catch (error) {
  await ui.screenshot("scopes-failure").catch(() => {})
  console.error(await ui.text().catch(() => "No UI"))
  throw error
} finally {
  await ui.stop()
  await f.cleanup()
}
