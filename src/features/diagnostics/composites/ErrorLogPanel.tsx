"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import type { DiagnosticLog } from "@/lib/desktop/contracts.generated"
import { diagnosticCommands } from "@/lib/desktop/diagnostics"
import { formatDiagnostic } from "@/lib/desktop/diagnostics.helpers"
import { desktopAvailable, errorMessage } from "@/lib/desktop/review.commands"
import { CopyDetailsButton } from "../components/CopyDetailsButton"

export function ErrorLogPanel() {
  const [log, setLog] = useState<DiagnosticLog | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    if (!desktopAvailable()) return
    let active = true
    void diagnosticCommands
      .read()
      .then((value) => {
        if (active) setLog(value)
      })
      .catch((cause) => {
        if (active) setError(errorMessage(cause))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])
  async function refresh() {
    setLoading(true)
    setError("")
    try {
      setLog(await diagnosticCommands.read())
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoading(false)
    }
  }
  if (!desktopAvailable())
    return (
      <p className="text-sm text-muted-foreground">
        Open the desktop app to access its error log.
      </p>
    )
  const entries = log?.entries ?? []
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void refresh()}
          disabled={loading}
        >
          {loading && <Spinner />} Refresh
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            void diagnosticCommands
              .reveal()
              .catch((cause) => setError(errorMessage(cause)))
          }
        >
          Reveal in Finder
        </Button>
        <CopyDetailsButton
          label="Copy recent errors"
          disabled={!entries.length}
          text={entries
            .map((entry) => formatDiagnostic(entry.error, entry))
            .join("\n\n---\n\n")}
        />
      </div>
      {log && (
        <p className="text-xs wrap-anywhere text-muted-foreground">
          {log.directory}
        </p>
      )}
      <p className="text-xs leading-5 text-muted-foreground">
        Kept on this device with automatic log rotation. Known credentials are
        redacted. Nothing is uploaded automatically.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!loading && !error && !entries.length && (
        <p
          role="status"
          className="rounded-2xl border p-5 text-sm text-muted-foreground"
        >
          No errors recorded yet.
        </p>
      )}
      {!!entries.length && (
        <div className="space-y-2" aria-label="Recent errors">
          <p className="text-xs text-muted-foreground">
            Latest {entries.length} {entries.length === 1 ? "error" : "errors"}{" "}
            · newest first
          </p>
          {entries.map((entry) => {
            const details = formatDiagnostic(entry.error, entry)
            return (
              <details
                key={entry.id}
                className="min-w-0 rounded-2xl border p-4"
              >
                <summary className="cursor-pointer space-y-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <span className="ml-1 font-medium">
                    {entry.error.message}
                  </span>
                  <span className="block text-xs wrap-anywhere text-muted-foreground">
                    {new Date(Number(entry.timestamp)).toLocaleString()} ·{" "}
                    {entry.error.source} · {entry.error.code}
                  </span>
                </summary>
                <div className="mt-3 space-y-2">
                  <CopyDetailsButton text={details} />
                  <pre
                    tabIndex={0}
                    className="max-h-72 overflow-auto rounded-xl bg-muted p-3 text-xs leading-5 wrap-anywhere whitespace-pre-wrap select-text"
                  >
                    {details}
                  </pre>
                </div>
              </details>
            )
          })}
        </div>
      )}
    </div>
  )
}
