import { invoke, isTauri } from "@tauri-apps/api/core"
import type {
  DiagnosticEntry,
  DiagnosticInput,
  DiagnosticLog,
} from "./contracts.generated"
import {
  appError,
  diagnosticInput,
  type DiagnosticContext,
} from "./diagnostics.helpers"

/** Raw IPC deliberately avoids the command failure reporter to prevent recursion. */
export const diagnosticCommands = {
  record: (input: DiagnosticInput, diagnosticId?: string) =>
    invoke<DiagnosticEntry>("diagnostics_record", { input, diagnosticId }),
  read: () => invoke<DiagnosticLog>("diagnostics_read"),
  reveal: () => invoke<void>("diagnostics_reveal"),
}

export async function reportDiagnostic(
  error: unknown,
  source: string,
  operation: string,
  context?: DiagnosticContext
): Promise<DiagnosticEntry | null> {
  const value = appError(error)
  if (
    !isTauri() ||
    ["cancelled", "canceled", "AbortError"].includes(value.code)
  )
    return null
  try {
    return await diagnosticCommands.record(
      diagnosticInput(error, source, operation, context),
      value.diagnosticId
    )
  } catch {
    // Disk/IPC failure must never hide the original failure or recursively log itself.
    return null
  }
}
