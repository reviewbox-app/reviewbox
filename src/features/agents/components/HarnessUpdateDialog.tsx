"use client"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import type {
  ProviderSetupEvent,
  ProviderStatus,
} from "@/lib/desktop/contracts.generated"
import { harnessNames } from "../hooks/useRevStatus"

export function HarnessUpdateDialog({
  status,
  latestVersion,
  busy,
  event,
  error,
  completed,
  onClose,
  onCancel,
  onRetry,
  onChooseExecutable,
}: {
  status: ProviderStatus
  latestVersion: string
  busy: boolean
  event: ProviderSetupEvent | null
  error: string
  completed: boolean
  onClose: () => void
  onCancel: () => void
  onRetry: () => void
  onChooseExecutable: () => void
}) {
  const name = harnessNames[status.provider] ?? status.provider
  const confirming = !busy && !event && !error && !completed
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {completed ? `${name} updated` : `Update ${name}`}
          </DialogTitle>
          <DialogDescription>
            {confirming
              ? `${name} ${latestVersion} is available. You have ${status.version}. Install the update?`
              : "Updates the selected installation and checks it again automatically."}
          </DialogDescription>
        </DialogHeader>
        {error && status.installation.command && (
          <code className="rounded-2xl bg-muted p-3 text-xs wrap-anywhere whitespace-pre-wrap">
            {status.installation.command}
          </code>
        )}
        {!status.installation.canRun && (
          <p role="alert" className="text-sm">
            {status.installation.message}
          </p>
        )}
        {(busy || event || completed) && (
          <p role="status" className="flex items-start gap-2 text-sm">
            {busy && <Spinner className="mt-0.5 shrink-0" />}
            <span>
              {completed
                ? "Update complete. Harness detected."
                : (event?.message ?? "Preparing the update…")}
            </span>
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm wrap-anywhere text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          {busy ? (
            <Button variant="secondary" onClick={onCancel}>
              Cancel update
            </Button>
          ) : (
            <>
              {!completed && status.installation.canRun && (
                <Button
                  variant={confirming ? "default" : "secondary"}
                  onClick={onRetry}
                >
                  {confirming ? "Install update" : "Retry update"}
                </Button>
              )}
              {!status.installation.canRun && (
                <Button variant="secondary" onClick={onChooseExecutable}>
                  Choose another exec
                </Button>
              )}
              <Button
                variant={confirming ? "secondary" : "default"}
                onClick={onClose}
              >
                {confirming ? "Not now" : "Done"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
