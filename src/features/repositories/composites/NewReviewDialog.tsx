"use client"
import { useEffect, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { reviewCommands, errorMessage } from "@/lib/desktop/review.commands"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import type {
  CaptureRequest,
  Repository,
  Scope,
} from "@/lib/desktop/contracts.generated"

export function NewReviewDialog({
  repository,
  open,
  busy,
  onClose,
  onCreate,
}: {
  repository: Repository
  open: boolean
  busy: boolean
  onClose: () => void
  onCreate: (request: CaptureRequest) => void
}) {
  const [scope, setScope] = useState<Scope>("local")
  const [base, setBase] = useState("HEAD~1")
  const [target, setTarget] = useState("HEAD")
  const [includeUntracked, setIncludeUntracked] = useState(false)
  const [settingsError, setSettingsError] = useState("")
  useEffect(() => {
    if (!open) return
    let alive = true
    reviewCommands
      .projectSettings(repository.id)
      .then((settings) => {
        if (alive) {
          setScope(settings.defaultScope)
          setIncludeUntracked(settings.includeUntracked)
          setSettingsError("")
        }
      })
      .catch((e) => {
        if (alive) setSettingsError(errorMessage(e))
      })
    return () => {
      alive = false
    }
  }, [open, repository.id])
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && !busy) onClose()
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Start a review</DialogTitle>
          <DialogDescription>
            Choose what to read. ReviewBox freezes this version so changes on
            disk never replace your review.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault()
            onCreate({
              repositoryId: repository.id,
              scope,
              base,
              target,
              includeUntracked,
            })
          }}
        >
          <div className="grid grid-cols-3 gap-2">
            {(
              [
                ["local", "Local changes"],
                ["unstaged", "Unstaged"],
                ["staged", "Staged"],
                ["commit", "Commit"],
                ["range", "Commit range"],
              ] as const
            ).map(([value, label]) => (
              <Button
                key={value}
                type="button"
                variant={scope === value ? "default" : "outline"}
                onClick={() => setScope(value)}
              >
                {label}
              </Button>
            ))}
          </div>
          {scope === "local" && (
            <p className="text-xs text-muted-foreground">
              Staged and unstaged layers are kept separately, including
              partially staged files.
            </p>
          )}
          {scope === "range" && (
            <div className="space-y-2">
              <Label htmlFor="base">Base reference</Label>
              <Input
                id="base"
                value={base}
                onChange={(e) => setBase(e.target.value)}
                required
              />
            </div>
          )}
          {(scope === "range" || scope === "commit") && (
            <div className="space-y-2">
              <Label htmlFor="target">Target reference</Label>
              <Input
                id="target"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                required
              />
            </div>
          )}
          {(scope === "local" || scope === "unstaged") && (
            <Label>
              <Checkbox
                checked={includeUntracked}
                onCheckedChange={(v) => setIncludeUntracked(v === true)}
              />
              Include untracked files
            </Label>
          )}
          {settingsError && (
            <p role="alert" className="text-destructive">
              {settingsError}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              type="button"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button disabled={busy}>
              {busy ? "Capturing snapshot…" : "Freeze snapshot"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
