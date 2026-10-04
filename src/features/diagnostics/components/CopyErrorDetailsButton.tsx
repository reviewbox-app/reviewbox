"use client"

import { useEffect, useState } from "react"
import type { DiagnosticEntry } from "@/lib/desktop/contracts.generated"
import { diagnosticCommands } from "@/lib/desktop/diagnostics"
import {
  appError,
  diagnosticInput,
  formatDiagnostic,
  type DiagnosticContext,
} from "@/lib/desktop/diagnostics.helpers"
import { desktopAvailable } from "@/lib/desktop/review.commands"
import { CopyDetailsButton } from "./CopyDetailsButton"

export function CopyErrorDetailsButton({
  error,
  source,
  operation,
  context,
}: {
  error: unknown
  source: string
  operation: string
  context?: DiagnosticContext
}) {
  const input = diagnosticInput(error, source, operation, context)
  const diagnosticId = appError(error).diagnosticId
  const request = JSON.stringify(input)
  const [saved, setSaved] = useState<{
    request: string
    diagnosticId?: string
    entry: DiagnosticEntry
  } | null>(null)
  useEffect(() => {
    if (!desktopAvailable()) return
    let active = true
    void diagnosticCommands
      .record(JSON.parse(request), diagnosticId)
      .then((entry) => {
        if (active) setSaved({ request, diagnosticId, entry })
      })
      .catch(() => {
        /* Copy still works using the redacted, in-memory error. */
      })
    return () => {
      active = false
    }
  }, [request, diagnosticId])
  const entry =
    saved?.request === request && saved.diagnosticId === diagnosticId
      ? saved.entry
      : undefined
  return (
    <CopyDetailsButton text={formatDiagnostic(entry?.error ?? input, entry)} />
  )
}
