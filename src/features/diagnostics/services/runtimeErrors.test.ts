import { expect, test } from "bun:test"
import { observeRuntimeErrors } from "./runtimeErrors"

test("runtime errors and unhandled rejections are reported once and listeners are disposed", () => {
  const target = new EventTarget()
  const received: { error: unknown; source: string; operation: string }[] = []
  const stop = observeRuntimeErrors(
    target as Window,
    async (error, source, operation) => {
      received.push({ error, source, operation })
      return null
    }
  )
  const error = new Error("render failed")
  target.dispatchEvent(Object.assign(new Event("error"), { error }))
  target.dispatchEvent(
    Object.assign(new Event("unhandledrejection"), { reason: error })
  )
  expect(received.map((entry) => entry.operation)).toEqual([
    "window.error",
    "unhandledrejection",
  ])
  expect(received.every((entry) => entry.error === error)).toBe(true)
  stop()
  target.dispatchEvent(Object.assign(new Event("error"), { error }))
  expect(received).toHaveLength(2)
})
