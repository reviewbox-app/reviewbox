import { expect, test } from "@playwright/test"

test("the bundled language model works in a worker without external requests", async ({
  page,
}) => {
  const external: string[] = []
  page.on("request", (request) => {
    if (!request.url().startsWith("http://127.0.0.1:1423/"))
      external.push(request.url())
  })
  await page.goto("/dev/editor-chrome/")
  const result = await page.evaluate(
    () =>
      new Promise<{
        error?: string
        candidates?: { languageId: string; confidence: number }[]
      }>((resolve) => {
        const worker = new Worker("/monaco/language-detection.worker.js")
        worker.onmessage = (event) => {
          worker.terminate()
          resolve(event.data)
        }
        worker.onerror = (event) => {
          worker.terminate()
          resolve({ error: event.message })
        }
        worker.postMessage({
          id: "python",
          content:
            'from pathlib import Path\n\ndef greet(name: str) -> str:\n    return f"Hello {name}"\n\nif __name__ == "__main__":\n    print(greet("world"))',
        })
      })
  )
  expect(result.error).toBeUndefined()
  expect(result.candidates?.[0]?.languageId).toBe("py")
  expect(
    result.candidates?.every((candidate) =>
      Number.isFinite(candidate.confidence)
    )
  ).toBe(true)
  expect(external).toEqual([])
})
