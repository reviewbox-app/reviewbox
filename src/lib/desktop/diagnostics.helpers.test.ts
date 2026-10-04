import { expect, test } from "bun:test"
import {
  appError,
  diagnosticInput,
  formatDiagnostic,
  redactDiagnosticText,
} from "./diagnostics.helpers"

test("reports preserve error causes and correlation without serializing request payloads", () => {
  const error = Object.assign(
    new Error("Codex could not complete the request", {
      cause: new Error("HTTP 403"),
    }),
    {
      code: "provider_authentication",
      details: "Authorization: Bearer confidential-token",
      diagnosticId: "logged-error",
      request: { prompt: "source code sentinel" },
    }
  )
  const input = diagnosticInput(error, "rev", "review_preparation", {
    reviewId: "review",
    prompt: "source code sentinel",
    provider: "codex",
  })
  const report = formatDiagnostic(input)
  expect(report).toContain("provider_authentication")
  expect(report).toContain("reviewId: review")
  expect(report).toContain("HTTP 403")
  expect(report).toContain("Stack:")
  expect(report).not.toContain("confidential-token")
  expect(JSON.stringify(input)).not.toContain("source code sentinel")
  expect(appError(error).diagnosticId).toBe("logged-error")
})

test("shared redaction rules cover credentials, incomplete values and Unicode limits", () => {
  for (const value of [
    "api_key='secret-value with spaces'",
    '{"token":"secret-value with spaces"}',
    "password=secret-value",
    "https://user:secret-value@example.test",
    "-----BEGIN PRIVATE KEY-----\nsecret-value\n-----END PRIVATE KEY-----",
    'client_secret="secret-value with spaces',
    "Authorization: Bearer secret-value",
  ])
    expect(redactDiagnosticText(value)).not.toContain("secret-value")
  expect(redactDiagnosticText("é".repeat(100_000), 200)).toBe(
    `${"é".repeat(200)}\n[truncated]`
  )
})

test("unknown or circular rejections cannot break error reporting", () => {
  const error: Record<string, unknown> = { message: "failure" }
  error.cause = error
  expect(diagnosticInput(error, "frontend", "error").details).toBeNull()
  const hostile = {
    get message() {
      throw new Error("getter")
    },
    secret: "do not stringify",
  }
  expect(diagnosticInput(hostile, "frontend", "error").message).toBe(
    "An unexpected error occurred."
  )
  expect(diagnosticInput(undefined, "frontend", "error").code).toBe(
    "unexpected_error"
  )
})
