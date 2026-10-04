import rules from "../../../resources/diagnostics/redaction.json"
import type {
  AppError,
  DiagnosticEntry,
  DiagnosticInput,
} from "./contracts.generated"

const contextKeys = new Set([
  "repositoryId",
  "reviewId",
  "snapshotId",
  "operationId",
  "provider",
  "phase",
  "batchId",
  "window",
  "model",
  "harnessVersion",
])
const patterns = rules.map(
  ({ pattern, flags }) => new RegExp(pattern, `g${flags}`)
)

/** The same rules are enforced natively before any error reaches disk. */
export function redactDiagnosticText(text: string, limit = 16_384) {
  let value = Array.from(text.slice(0, 131_072))
    .slice(0, 65_536)
    .join("")
    .replace(new RegExp("\\p{Cc}", "gu"), (c) =>
      c === "\n" || c === "\t" ? c : ""
    )
  for (const pattern of patterns) value = value.replace(pattern, "[redacted]")
  const chars = Array.from(value)
  return chars.length > limit
    ? `${chars.slice(0, limit).join("")}\n[truncated]`
    : value
}

function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined
  try {
    return (value as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}
const text = (value: unknown) => (typeof value === "string" ? value : undefined)

/** Never stringify an arbitrary rejection: it may contain a prompt or a request. */
export function appError(error: unknown): AppError {
  return {
    code:
      text(field(error, "code")) ??
      text(field(error, "name")) ??
      "unexpected_error",
    message:
      text(field(error, "message")) ??
      text(error) ??
      "An unexpected error occurred.",
    retryable: field(error, "retryable") === true,
    details: text(field(error, "details")),
    diagnosticId: text(field(error, "diagnosticId")),
  }
}

export type DiagnosticContext = Record<string, string | null | undefined>
export function diagnosticContext(
  context: Record<string, unknown>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(context).flatMap(([key, value]) =>
      contextKeys.has(key) && typeof value === "string"
        ? [[key, redactDiagnosticText(value, 256)]]
        : []
    )
  )
}
export function diagnosticInput(
  error: unknown,
  source: string,
  operation: string,
  context: DiagnosticContext = {}
): DiagnosticInput {
  const value = appError(error)
  const causes = []
  let cause: unknown = field(error, "cause")
  const seen = new Set<unknown>([error])
  while (cause && !seen.has(cause) && causes.length < 4) {
    seen.add(cause)
    causes.push(`Caused by: ${appError(cause).message}`)
    cause = field(cause, "cause")
  }
  const details = [value.details, ...causes].filter(Boolean).join("\n")
  return {
    source: redactDiagnosticText(source, 64),
    operation: redactDiagnosticText(operation, 256),
    code: redactDiagnosticText(value.code, 128),
    message: redactDiagnosticText(value.message, 2048),
    details: details ? redactDiagnosticText(details) : null,
    stack: text(field(error, "stack"))
      ? redactDiagnosticText(text(field(error, "stack"))!, 8192)
      : null,
    context: diagnosticContext(context),
  }
}

export function formatDiagnostic(
  input: DiagnosticInput,
  entry?: DiagnosticEntry
) {
  const date = entry ? new Date(Number(entry.timestamp)) : null
  const header = entry
    ? [
        `ReviewBox ${entry.appVersion} · ${entry.platform}`,
        `Error ID: ${entry.id}`,
        `Time: ${date && Number.isFinite(date.getTime()) ? date.toISOString() : entry.timestamp}`,
        `Session: ${entry.sessionId}`,
      ]
    : ["ReviewBox error details"]
  return [
    ...header,
    `Source: ${input.source}`,
    `Operation: ${input.operation}`,
    `Code: ${input.code}`,
    ...Object.entries(input.context).map(([key, value]) => `${key}: ${value}`),
    "",
    input.message,
    ...(input.details ? ["", "Details:", input.details] : []),
    ...(input.stack ? ["", "Stack:", input.stack] : []),
  ].join("\n")
}
