"use client"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import type {
  ProviderConfig,
  ProviderStatus,
} from "@/lib/desktop/contracts.generated"
import { errorMessage } from "@/lib/desktop/review.commands"
import { harnessNames } from "../hooks/useRevStatus"
import { setupCommands } from "../services/setup.commands"
import { ModelSelector } from "../components/ModelSelector"

export function HarnessConfigurationDialog({
  mode,
  status,
  config,
  onClose,
  onSave,
}: {
  mode: "details" | "executable"
  status: ProviderStatus
  config: ProviderConfig
  onClose: () => void
  onSave: (
    patch: Partial<Pick<ProviderConfig, "executable" | "model">>
  ) => Promise<void>
}) {
  const [value, setValue] = useState(
    mode === "details" ? (config.model ?? "") : config.executable
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const name = harnessNames[status.provider] ?? status.provider
  const id = `${mode === "details" ? "model" : "executable"}-${status.provider}`
  const browse = async () => {
    setBusy(true)
    setError("")
    try {
      const selected = await setupCommands.chooseExecutable()
      if (selected) setValue(selected)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
        showCloseButton={!busy}
      >
        <DialogHeader>
          <DialogTitle>
            {mode === "details"
              ? `${name} details`
              : `Choose another ${name} executable`}
          </DialogTitle>
          <DialogDescription>
            {mode === "details"
              ? "Installation details and the model used by Rev."
              : "Select the CLI executable on this Mac, or enter its full path."}
          </DialogDescription>
        </DialogHeader>
        {mode === "details" && (
          <dl className="grid grid-cols-[80px_minmax(0,1fr)] gap-x-4 gap-y-3 text-xs [&_dd]:wrap-anywhere">
            <dt className="text-muted-foreground">Version</dt>
            <dd>{status.version ?? "Unavailable"}</dd>
            <dt className="text-muted-foreground">Executable</dt>
            <dd className="font-mono">{status.executable}</dd>
            {status.minimumVersion && (
              <>
                <dt className="text-muted-foreground">Minimum</dt>
                <dd>{status.minimumVersion}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Sign-in</dt>
            <dd>
              {status.authentication === "authenticated"
                ? `Signed in through ${name}`
                : status.authentication === "signedOut"
                  ? `Sign in through ${name}`
                  : "Could not verify sign-in"}
            </dd>
            <dt className="text-muted-foreground">Status</dt>
            <dd>{status.message}</dd>
            <dt className="text-muted-foreground">Updates</dt>
            <dd>
              {status.compatibility === "compatible"
                ? "No update required."
                : status.compatibility === "outdated" &&
                    status.installation.canRun
                  ? "Available from Options › Update harness."
                  : status.installation.message}
            </dd>
          </dl>
        )}
        <form
          className="space-y-4"
          onSubmit={async (event) => {
            event.preventDefault()
            if (busy) return
            setBusy(true)
            setError("")
            try {
              await onSave(
                mode === "details"
                  ? { model: value.trim() || null }
                  : { executable: value.trim() }
              )
              onClose()
            } catch (e) {
              setError(errorMessage(e))
            } finally {
              setBusy(false)
            }
          }}
        >
          <div className="space-y-2">
            <Label htmlFor={id}>
              {mode === "details" ? "Model override" : "Executable"}
            </Label>
            {mode === "details" ? (
              <ModelSelector
                id={id}
                provider={status.provider}
                executable={config.executable}
                value={value || null}
                defaultLabel="Harness default"
                disabled={busy}
                onChange={(model) => setValue(model ?? "")}
              />
            ) : (
              <div className="flex gap-2">
                <Input
                  id={id}
                  aria-label={`${status.provider} executable`}
                  value={value}
                  disabled={busy}
                  required
                  onChange={(event) => setValue(event.target.value)}
                  className="min-w-0"
                />
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void browse()}
                >
                  Browse…
                </Button>
              </div>
            )}
            {mode === "details" && (
              <p className="text-xs text-muted-foreground">
                Used for Rev’s reading paths and explanations.
              </p>
            )}
          </div>
          {error && (
            <p role="alert" className="text-sm wrap-anywhere text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={busy || (mode === "executable" && !value.trim())}
            >
              {busy && <Spinner />}
              {mode === "details" ? "Save" : "Save and detect again"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
