"use client"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { CodeDiffEditor } from "@/features/code-editor/components/CodeDiffEditor"
import { dirty, getEditor } from "@/features/code-editor/stores/editor.store"
import type {
  LanguageSetupPlan,
  LanguageSetupStatus,
} from "@/lib/desktop/contracts.generated"
import { errorMessage } from "@/lib/desktop/review.commands"
import { languageSetupCommands as commands } from "../services/languageSetup.commands"

export function LanguageSetupDialog({
  repositoryId,
  path,
  diagnostic,
  onClose,
  onApplied,
}: {
  repositoryId: string
  path: string
  diagnostic: string
  onClose: () => void
  onApplied: () => void
}) {
  const [initialDiagnostic] = useState(diagnostic)
  const [operationId, setOperationId] = useState(() => crypto.randomUUID())
  const [fresh, setFresh] = useState(false)
  const [plan, setPlan] = useState<LanguageSetupPlan | null>(null)
  const [status, setStatus] = useState<LanguageSetupStatus | null>(null)
  const [message, setMessage] = useState("Rev is inspecting the project…")
  const [error, setError] = useState("")
  const [planning, setPlanning] = useState(true)
  const applying = status?.phase === "applying"
  useEffect(() => {
    let alive = true
    // Delay dispatch to avoid duplicate harness runs during React's mount probe.
    const timer = setTimeout(() => {
      void (async () => {
        const existing = fresh
          ? null
          : await commands.latest(repositoryId, path)
        if (existing?.plan) {
          if (alive) {
            setStatus(existing)
            setPlan(existing.plan)
          }
          return null
        }
        return commands.plan(
          repositoryId,
          path,
          operationId,
          initialDiagnostic,
          (event) => {
            if (alive && event.kind === "status") setMessage(event.text)
          }
        )
      })()
        .then((result) => {
          if (alive && result) setPlan(result)
        })
        .catch((e) => {
          if (alive) setError(errorMessage(e))
        })
        .finally(() => {
          if (alive) setPlanning(false)
        })
    }, 0)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [repositoryId, path, initialDiagnostic, operationId, fresh])
  useEffect(() => {
    if (!applying) return
    let alive = true
    const timer = setInterval(() => {
      void commands
        .status(status!.id)
        .then((next) => {
          if (!alive) return
          setStatus(next)
          if (next.phase === "ready") onApplied()
        })
        .catch((e) => {
          if (alive) setError(errorMessage(e))
        })
    }, 500)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [applying, status, onApplied])
  const close = async () => {
    if (planning || applying)
      await commands.cancel(status?.id ?? operationId).catch(() => {})
    onClose()
  }
  const apply = async () => {
    if (!plan) return
    if (
      plan.files.some((f) =>
        getEditor(repositoryId)?.buffers.some(
          (b) => b.path === f.path && dirty(b)
        )
      ) ||
      (plan.commands.length > 0 && getEditor(repositoryId)?.buffers.some(dirty))
    ) {
      setError("Save your affected files before applying this configuration.")
      return
    }
    setError("")
    try {
      setStatus(await commands.apply(plan.id))
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void close()
      }}
    >
      <DialogContent className="flex max-h-[85vh] max-w-3xl flex-col sm:max-w-3xl">
        <DialogTitle>Configure language support with Rev</DialogTitle>
        <DialogDescription>{plan ? plan.summary : message}</DialogDescription>
        <div className="min-h-0 flex-1 space-y-4 overflow-auto">
          {plan && (
            <>
              <p className="text-sm">
                {plan.server
                  ? `Language server: ${plan.server.name} · ${plan.server.version}`
                  : "Syntax highlighting configuration"}
              </p>
              {plan.server && (
                <details className="text-sm">
                  <summary>Installation recipe and source</summary>
                  <a
                    href={plan.server.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary underline"
                  >
                    {plan.server.sourceUrl}
                  </a>
                  <p className="text-muted-foreground">
                    Managed tools are installed in ReviewBox’s private data.
                  </p>
                  <pre className="max-h-64 overflow-auto rounded-xl bg-muted p-3 text-xs">
                    {JSON.stringify(plan.server.recipe, null, 2)}
                  </pre>
                </details>
              )}
              {plan.pack && (
                <details>
                  <summary>
                    Language pack · {plan.pack.name} {plan.pack.version}
                  </summary>
                  <a
                    href={plan.pack.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary underline"
                  >
                    Source
                  </a>
                  <pre className="max-h-64 overflow-auto rounded-xl bg-muted p-3 text-xs">
                    {JSON.stringify(plan.pack, null, 2)}
                  </pre>
                </details>
              )}
              {plan.prerequisites.length > 0 && (
                <div>
                  <p className="font-medium">Prerequisites</p>
                  <ul className="list-disc pl-5 text-sm">
                    {plan.prerequisites.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </div>
              )}
              {plan.files.map((file) => (
                <div key={file.path}>
                  <p className="mb-1 text-sm font-medium">{file.path}</p>
                  <CodeDiffEditor
                    height={240}
                    original={file.before ?? ""}
                    modified={file.after}
                    options={{ readOnly: true }}
                  />
                </div>
              ))}
              {plan.commands.map((command, index) => (
                <div key={index} className="rounded-xl border p-3 text-sm">
                  <p>{command.purpose}</p>
                  <p className="text-muted-foreground">
                    Working directory: {command.directory}
                  </p>
                  <pre className="overflow-auto text-xs">
                    {JSON.stringify([command.executable, ...command.arguments])}
                  </pre>
                </div>
              ))}
            </>
          )}
          {status && (
            <div role="status">
              <p>{status.message}</p>
              <ul className="list-disc pl-5 text-sm">
                {status.completedSteps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </div>
          )}
          {status?.log && (
            <details>
              <summary>Installation log</summary>
              <pre className="max-h-64 overflow-auto text-xs whitespace-pre-wrap">
                {status.log}
              </pre>
            </details>
          )}
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => void close()}>
            {planning || applying ? "Cancel" : "Close"}
          </Button>
          {plan &&
            !applying &&
            status?.phase !== "ready" &&
            status?.inFlightCommand == null && (
              <Button onClick={() => void apply()}>
                {!status || status.phase === "planned"
                  ? "Apply plan"
                  : "Resume approved plan"}
              </Button>
            )}
          {status && !applying && status.phase !== "ready" && (
            <Button
              variant="secondary"
              onClick={() => {
                setPlan(null)
                setStatus(null)
                setError("")
                setPlanning(true)
                setFresh(true)
                setOperationId(crypto.randomUUID())
              }}
            >
              Request a new plan
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
