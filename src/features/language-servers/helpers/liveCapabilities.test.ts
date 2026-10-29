import { expect, test } from "bun:test"
import { documentCapability, matchesDocument } from "./liveCapabilities"

test("dynamic registrations respect language, scheme and path selectors", () => {
  const selector = [
    { language: "typescript", scheme: "file", pattern: "**/src/**/*.{ts,tsx}" },
  ]
  expect(
    matchesDocument(selector, "file:///project/src/a.tsx", "typescript")
  ).toBe(true)
  expect(
    matchesDocument(selector, "file:///project/test/a.tsx", "typescript")
  ).toBe(false)
  expect(matchesDocument(selector, "file:///project/src/a.py", "python")).toBe(
    false
  )
  expect(
    matchesDocument(selector, "reviewbox://project/src/a.ts", "typescript")
  ).toBe(false)
})
test("relative patterns stay within their declared root", () => {
  const selector = [
    { pattern: { baseUri: "file:///project/src", pattern: "**/*.ts" } },
  ]
  expect(
    matchesDocument(selector, "file:///project/src/a.ts", "typescript")
  ).toBe(true)
  expect(
    matchesDocument(selector, "file:///project/src-other/a.ts", "typescript")
  ).toBe(false)
})
test("unmatched registrations retain the server's static provider", () => {
  const capabilities = {
    completionProvider: { triggerCharacters: ["#"] },
    reviewboxStaticCapabilities: {
      completionProvider: { triggerCharacters: ["."] },
    },
    reviewboxRegistrations: [
      {
        method: "textDocument/completion",
        registerOptions: {
          documentSelector: [{ language: "python" }],
          triggerCharacters: ["#"],
        },
      },
    ],
  }
  expect(
    documentCapability(
      capabilities,
      "completionProvider",
      "file:///a.ts",
      "typescript"
    )
  ).toEqual({ triggerCharacters: ["."] })
  expect(
    documentCapability(
      capabilities,
      "completionProvider",
      "file:///a.py",
      "python"
    )
  ).toMatchObject({ triggerCharacters: ["#"] })
  expect(
    documentCapability(
      { reviewboxRegistrations: [] },
      "completionProvider",
      "file:///a",
      "typescript"
    )
  ).toBeUndefined()
})
