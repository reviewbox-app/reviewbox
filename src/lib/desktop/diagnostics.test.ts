import { afterEach, beforeEach, expect, test } from "bun:test"
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks"
import type { DiagnosticInput } from "./contracts.generated"
import { call, setActiveRepository } from "./review.commands"

const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window")
const tauriDescriptor = Object.getOwnPropertyDescriptor(globalThis, "isTauri")
beforeEach(() => {
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true })
  Object.defineProperty(globalThis, "isTauri", {
    value: true,
    configurable: true,
  })
  setActiveRepository("current-repository")
})
afterEach(() => {
  clearMocks()
  for (const [key, descriptor] of [
    ["window", windowDescriptor],
    ["isTauri", tauriDescriptor],
  ] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
  setActiveRepository(null)
})

test("IPC failures retain their identity while recording only allowed context", async () => {
  const original = {
    code: "provider_error",
    message: "Request failed",
    details: "Bearer private-token",
    retryable: true,
  }
  const logged: DiagnosticInput[] = []
  mockIPC((command, args) => {
    if (command === "diagnostics_record") {
      if (!args || !("input" in args))
        throw new Error("Missing diagnostic input")
      logged.push(args.input as DiagnosticInput)
      return { id: "error-id" }
    }
    throw original
  })
  let rejected: unknown
  try {
    await call("prepare_review", {
      repositoryId: "other-repository",
      reviewId: "review",
      content: "private source",
      request: { token: "secret" },
    })
  } catch (error) {
    rejected = error
  }
  expect(rejected).toBe(original)
  expect(rejected).toMatchObject({ diagnosticId: "error-id", retryable: true })
  expect(logged).toHaveLength(1)
  expect(logged[0].context).toEqual({
    repositoryId: "other-repository",
    reviewId: "review",
  })
  expect(JSON.stringify(logged)).not.toMatch(
    /private-token|private source|secret/
  )
})

test("logging failure never replaces the original rejection or causes recursion", async () => {
  const calls: string[] = []
  const original = { code: "io", message: "Write failed" }
  mockIPC((command) => {
    calls.push(command)
    throw command === "diagnostics_record" ? new Error("disk full") : original
  })
  await expect(call("editor_save")).rejects.toBe(original)
  expect(calls).toEqual(["editor_save", "diagnostics_record"])
})

test("user cancellation is not recorded as an application failure", async () => {
  const calls: string[] = []
  mockIPC((command) => {
    calls.push(command)
    throw { code: "cancelled", message: "Cancelled" }
  })
  await expect(call("cancel_preparation")).rejects.toMatchObject({
    code: "cancelled",
  })
  expect(calls).toEqual(["cancel_preparation"])
})
