"use client"
import { useEffect, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Camera01Icon,
  GitBranchIcon,
  InformationCircleIcon,
  SecurityCheckIcon,
} from "@hugeicons/core-free-icons"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { reviewCommands, errorMessage } from "@/lib/desktop/review.commands"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Kbd } from "@/components/ui/kbd"
import { Checkbox } from "@/components/ui/checkbox"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { cn } from "@/lib/utils"
import type {
  CaptureRequest,
  Repository,
  Scope,
} from "@/lib/desktop/contracts.generated"

const scopes: { value: Scope; title: string; detail: string }[] = [
  {
    value: "local",
    title: "Local changes",
    detail: "Staged and unstaged, kept as separate layers",
  },
  {
    value: "unstaged",
    title: "Unstaged changes",
    detail: "What is in the working tree only",
  },
  {
    value: "staged",
    title: "Staged changes",
    detail: "What the next commit would contain",
  },
  {
    value: "commit",
    title: "A commit",
    detail: "Review exactly what one commit changed",
  },
  {
    value: "range",
    title: "A range of commits",
    detail: "Compare a base with a target",
  },
]

const notes: Record<Scope, string[]> = {
  local: [
    "Partially staged files keep both the staged and the working version.",
    "Renamed files are compared with their previous path.",
    "Binary files are listed, not displayed.",
  ],
  unstaged: [
    "Only the difference between the index and the working tree.",
    "Binary files are listed, not displayed.",
  ],
  staged: [
    "Only the difference between HEAD and the index.",
    "Unstaged edits to the same files stay out of this review.",
  ],
  commit: ["The commit is compared with its first parent."],
  range: ["Every change between the base and the target, as one snapshot."],
}

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
  const submit = () =>
    onCreate({
      repositoryId: repository.id,
      scope,
      base,
      target,
      includeUntracked,
    })
  const untracked = scope === "local" || scope === "unstaged"
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && !busy) onClose()
      }}
    >
      <DialogContent className="flex h-[min(760px,calc(100vh-4rem))] flex-col gap-0 p-0 sm:max-w-5xl">
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !busy) {
              e.preventDefault()
              submit()
            }
          }}
        >
          <header className="border-b px-6 pt-5 pb-4">
            <DialogTitle className="text-lg">New review</DialogTitle>
            <DialogDescription className="mt-1 flex items-center gap-1.5 text-xs">
              <HugeiconsIcon icon={GitBranchIcon} size={12} />
              {repository.name} · {repository.branch}
            </DialogDescription>
          </header>
          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,5fr)_minmax(0,7fr)] max-md:grid-cols-1">
            <div className="min-h-0 overflow-auto border-r p-6 max-md:border-r-0">
              <h3 className="mb-3 text-sm font-medium">
                What do you want to review?
              </h3>
              <RadioGroup
                value={scope}
                onValueChange={(value) => setScope(value as Scope)}
                className="gap-2"
              >
                {scopes.map((item) => (
                  <label
                    key={item.value}
                    className={cn(
                      "block cursor-pointer rounded-3xl border bg-card p-4 transition-colors hover:bg-accent/40",
                      scope === item.value &&
                        "border-primary bg-accent/60 hover:bg-accent/60"
                    )}
                  >
                    <span className="flex items-start gap-3">
                      <RadioGroupItem value={item.value} className="mt-0.5" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">
                          {item.title}
                        </span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {item.detail}
                        </span>
                      </span>
                    </span>
                    {scope === item.value && item.value === "commit" && (
                      <Input
                        aria-label="Commit"
                        className="mt-3 font-mono text-xs"
                        value={target}
                        onChange={(e) => setTarget(e.target.value)}
                        required
                      />
                    )}
                    {scope === item.value && item.value === "range" && (
                      <span className="mt-3 flex items-center gap-2">
                        <Input
                          aria-label="Base reference"
                          className="font-mono text-xs"
                          value={base}
                          onChange={(e) => setBase(e.target.value)}
                          required
                        />
                        <span className="text-muted-foreground">›</span>
                        <Input
                          aria-label="Target reference"
                          className="font-mono text-xs"
                          value={target}
                          onChange={(e) => setTarget(e.target.value)}
                          required
                        />
                      </span>
                    )}
                  </label>
                ))}
              </RadioGroup>
            </div>
            <div className="min-h-0 overflow-auto p-6">
              <h3 className="flex items-center gap-2 text-sm font-medium">
                <HugeiconsIcon icon={Camera01Icon} size={16} />
                Snapshot
              </h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Frozen when you start: later edits in the repository won’t
                change what you review. You’ll be offered a refresh instead.
              </p>
              <ul className="mt-5 space-y-2">
                {notes[scope].map((note) => (
                  <li
                    key={note}
                    className="flex gap-2 text-xs leading-5 text-muted-foreground"
                  >
                    <HugeiconsIcon
                      icon={InformationCircleIcon}
                      size={14}
                      className="mt-0.5 shrink-0"
                    />
                    {note}
                  </li>
                ))}
              </ul>
              {untracked && (
                <Label className="mt-6 font-normal">
                  <Checkbox
                    checked={includeUntracked}
                    onCheckedChange={(v) => setIncludeUntracked(v === true)}
                  />
                  Include untracked files
                </Label>
              )}
              {settingsError && (
                <p role="alert" className="mt-4 text-sm text-destructive">
                  {settingsError}
                </p>
              )}
            </div>
          </div>
          <footer className="flex items-center gap-3 border-t px-6 py-3">
            <span className="flex flex-1 items-center gap-1.5 text-xs text-muted-foreground">
              <HugeiconsIcon icon={SecurityCheckIcon} size={14} />
              Read-only: nothing in the repository is checked out, staged or
              reset.
            </span>
            <Button
              variant="ghost"
              type="button"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </Button>
            <Kbd>⌘↵</Kbd>
            <Button disabled={busy}>
              <HugeiconsIcon icon={Camera01Icon} size={16} />
              {busy ? "Capturing snapshot…" : "Freeze snapshot and start"}
            </Button>
          </footer>
        </form>
      </DialogContent>
    </Dialog>
  )
}
