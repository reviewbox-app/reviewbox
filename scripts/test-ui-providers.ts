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
  await ui.named("Ask Rev", '[role="tab"]')
  for (const provider of ["codex", "claude"]) {
    console.log(`Provider UI: ${provider}`)
    await ui.select('select[aria-label="Rev\'s harness"]', provider)
    await ui.fill(
      '[aria-label="Question for Rev"]',
      "Reply with one sentence explaining the supplied change. Do not use tools."
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
          text.includes("Keep as note") ||
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
    else {
      await ui.named("Keep as note")
      results.push({
        provider,
        outcome: "answer streamed and kept as a shared note",
      })
    }
    await ui.screenshot(`provider-${provider}`)
  }
  await ui.select('select[aria-label="Rev\'s harness"]', "codex")
  await ui.select('select[aria-label="What Rev should do"]', "topics")
  await ui.fill(
    '[aria-label="Question for Rev"]',
    "Suggest one short topic for the supplied change, using the exact canonical anchors."
  )
  await ui.click('button[aria-label="Ask Rev"]')
  await ui.wait(
    async () => (await ui.text()).includes("Accept edited proposal"),
    "structured topic proposal",
    90000
  )
  await ui.fill('[aria-label="Proposed topic title"]', "Accepted UI proposal")
  await ui.named("Accept edited proposal")
  await ui.has("Accepted UI proposal")
  results.push({
    provider: "codex",
    outcome: "structured topics edited and accepted through the UI",
  })
  await ui.select('select[aria-label="What Rev should do"]', "ask")
  await ui.fill(
    '[aria-label="Question for Rev"]',
    "Explain the supplied changes."
  )
  await ui.click('button[aria-label="Ask Rev"]')
  await ui.named("Stop")
  await ui.has("Agent request stopped")
  results.push({
    provider: "codex",
    outcome: "in-flight request cancelled through the UI",
  })
  await ui.named("Understand", '[role="tab"]')
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
  await ui.select('select[aria-label="What Rev should do"]', "glossary")
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
