import { expect, test } from "bun:test"
import { LanguageDetectionClient } from "./languageDetection.service"

function fixture() {
  let created = 0
  let terminated = false
  let request: { id: string; content: string } | undefined
  const worker = {
    onmessage: undefined as ((event: MessageEvent) => void) | undefined,
    onerror: undefined as (() => void) | undefined,
    postMessage: (value: typeof request) => {
      request = value
    },
    terminate: () => {
      terminated = true
    },
  }
  const client = new LanguageDetectionClient(() => {
    created++
    return worker as unknown as Worker
  })
  return {
    client,
    worker,
    created: () => created,
    terminated: () => terminated,
    request: () => request!,
  }
}

test("model stays lazy for short content and bounds requests to 100000 characters", async () => {
  const f = fixture()
  const controller = new AbortController()
  expect(await f.client.detect("short", controller.signal)).toEqual([])
  expect(f.created()).toBe(0)
  const result = f.client.detect("x".repeat(200000), controller.signal)
  expect(f.request().content.length).toBe(100000)
  f.worker.onmessage!({
    data: {
      id: f.request().id,
      candidates: [{ languageId: "py", confidence: 0.9 }],
    },
  } as MessageEvent)
  expect(await result).toEqual([{ languageId: "py", confidence: 0.9 }])
  f.client.dispose()
})

test("an obsolete owner cannot receive a late prediction", async () => {
  const f = fixture()
  const controller = new AbortController()
  const result = f.client.detect("a substantial source file", controller.signal)
  controller.abort()
  f.worker.onmessage!({
    data: {
      id: f.request().id,
      candidates: [{ languageId: "py", confidence: 0.9 }],
    },
  } as MessageEvent)
  await expect(result).rejects.toThrow("Detection cancelled")
  expect(f.terminated()).toBe(true)
  f.client.dispose()
})

test("worker failures settle pending requests without affecting other editor work", async () => {
  const f = fixture()
  const result = f.client.detect(
    "a substantial source file",
    new AbortController().signal
  )
  f.worker.onerror!()
  await expect(result).rejects.toThrow("Language detection unavailable")
  expect(f.terminated()).toBe(true)
})
