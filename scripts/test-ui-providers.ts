import assert from "node:assert/strict"
import { NativeUI, fixture } from "../tests/native/ui-driver"

const f = await fixture()
const ui = new NativeUI()
const results: { provider: string; outcome: string }[] = []
try {
  await ui.start(`${f.root}/appdata`)
  await ui.named("or enter a path")
  await ui.fill('[aria-label="Repository path"]', f.repo)
  await ui.named("Open")
  await ui.startManualReview()
  await ui.until("!!document.querySelector('.monaco-editor')")
  if (process.env.REVIEWBOX_TEST_CODEX) {
    await ui.keys("\uE03D", "k")
    await ui.fill('[role="combobox"]', "Settings")
    await ui.named("Settings", '[role="option"]', false)
    await ui.named("Rev")
    await ui.setHarnessExecutable("codex", process.env.REVIEWBOX_TEST_CODEX)
    await ui.keys("\uE00C")
  }
  // The review itself has no chat with Rev any more: harnesses are exercised
  // from Code Explain, where Rev explains a file.
  await ui.named("Code Explain", '[role="tab"]')
  await ui.fill('[aria-label="Filter files"]', "answer.ts")
  await ui.named("answer.ts", '[aria-label="Snapshot files"] button', false)
  await ui.named("Explain with Rev")
  for (const provider of ["codex", "claude"]) {
    console.log(`Provider UI: ${provider}`)
    await ui.select(
      'button[aria-label="Rev\'s harness"]',
      provider === "codex" ? "Codex" : "Claude Code"
    )
    await ui.fill(
      '[aria-label="Question for Rev"]',
      "Explain this tiny file in one source-linked section. Do not use tools."
    )
    await ui.until(
      "document.querySelector('button[aria-label=\"Ask Rev\"]')?.disabled === false",
      `${provider} is authenticated and supported`
    )
    await ui.click('button[aria-label="Ask Rev"]')
    await ui.wait(
      async () => {
        const text = await ui.text()
        return (
          text.includes("Review proposal") ||
          !!(await ui.execute(
            "return [...document.querySelectorAll('[role=alert]')].find(e=>e.getClientRects().length)?.textContent"
          ))
        )
      },
      `${provider} answer`,
      90000
    )
    const error = await ui.execute<string | null>(
      "return [...document.querySelectorAll('[role=alert]')].find(e=>e.getClientRects().length)?.textContent ?? null"
    )
    if (error) throw new Error(`${provider}: ${error}`)
    results.push({ provider, outcome: "explanation streamed as a proposal" })
    await ui.screenshot(`provider-${provider}`)
  }
  await ui.select('button[aria-label="Rev\'s harness"]', "Codex")
  await ui.click('button[aria-label="Ask Rev"]')
  await ui.named("Stop")
  await ui.has("Agent request stopped")
  results.push({
    provider: "codex",
    outcome: "in-flight request cancelled through the UI",
  })
  await ui.keys("\uE00C")
  await ui.named("Code Explain", '[role="tab"]')
  await ui.fill('[aria-label="Filter files"]', "answer.ts")
  await ui.named("answer.ts", '[aria-label="Snapshot files"] button', false)
  await ui.named("Explain with Rev")
  await ui.fill(
    '[aria-label="Question for Rev"]',
    "Explain this tiny file in one source-linked section."
  )
  await ui.click('button[aria-label="Ask Rev"]')
  await ui.wait(
    async () => (await ui.text()).includes("Accept edited proposal"),
    "file explanation proposal",
    90000
  )
  await ui.fill('[aria-label="Section title"]', "Verified file explanation")
  await ui.named("Accept edited proposal")
  await ui.keys("\uE00C")
  await ui.has("Verified file explanation")
  results.push({
    provider: "codex",
    outcome: "source-linked explanation edited, accepted and rendered",
  })
  await ui.named("Explain with Rev")
  await ui.select(
    'button[aria-label="What Rev should do"]',
    "Suggest project definitions"
  )
  await ui.fill(
    '[aria-label="Question for Rev"]',
    "Suggest exactly one glossary term: answer, meaning the exported response constant."
  )
  await ui.click('button[aria-label="Ask Rev"]')
  await ui.wait(
    async () => (await ui.text()).includes("Accept edited proposal"),
    "glossary proposal",
    90000
  )
  await ui.fill('[aria-label="Proposed term"]', "Rejected suggestion")
  await ui.named("Reject")
  await ui.keys("\uE00C")
  await ui.named("Glossary", '[role="tab"]')
  assert(!(await ui.text()).includes("Rejected suggestion"))
  results.push({
    provider: "codex",
    outcome:
      "glossary proposal reviewed and rejected without publishing the term",
  })
  assert.equal(f.git("write-tree"), f.index)
  await Bun.write(
    `${ui.artifacts}/providers.json`,
    JSON.stringify(results, null, 2)
  )
  console.log(JSON.stringify(results, null, 2))
} catch (error) {
  await ui.screenshot("provider-failure").catch(() => {})
  console.error(await ui.text().catch(() => "No UI"))
  throw error
} finally {
  await ui.stop()
  await f.cleanup()
}
