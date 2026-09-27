"use client"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTrigger,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import type { TestRun } from "@/lib/desktop/contracts.generated"
import { errorMessage } from "@/lib/desktop/review.commands"
import { cn } from "@/lib/utils"
import {
  ArrowReloadHorizontalIcon,
  InformationCircleIcon,
  TestTube01Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useEffect, useRef, useState } from "react"
import { evidenceCommands } from "../services/evidence.commands"

/** RB/Evidence outcome: what was observed, never more. */
function evidenceOutcome(run: TestRun, snapshotId: string) {
  const when = run.finishedAt
    ? new Date(Number(run.finishedAt)).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : ""
  const detail = `snapshot ${run.snapshotId.slice(0, 6)}${when ? ` · ${when}` : ""}`
  if (run.snapshotId !== snapshotId)
    return {
      label: "Outdated",
      className: "text-muted-foreground",
      detail: `Observed on ${detail}`,
      outdated: true,
    }
  if (run.status === "observed" && run.exitCode === 0)
    return run.snapshotMatches
      ? { label: "Passed", className: "text-review-validated", detail }
      : {
          label: "Passed",
          className: "text-review-attention",
          detail:
            "Source changed during the run · not matched to this snapshot",
        }
  if (run.status === "observed")
    return {
      label: `Failed · exit ${run.exitCode ?? "?"}`,
      className: "text-destructive",
      detail,
    }
  if (run.status === "declined")
    return {
      label: "Denied",
      className: "text-muted-foreground",
      detail: "You denied this command · nothing ran",
    }
  if (run.status === "cancelled")
    return { label: "Stopped", className: "text-review-attention", detail }
  return { label: "Could not run", className: "text-destructive", detail }
}

export function EvidencePanel({
  reviewId,
  snapshotId,
}: {
  reviewId: string
  snapshotId: string
}) {
  const [runs, setRuns] = useState<TestRun[]>([])
  const [permission, setPermission] = useState<TestRun | null>(null)
  const [output, setOutput] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const running = useRef<string | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    evidenceCommands
      .list(reviewId)
      .then((v) => {
        if (alive.current) setRuns(v)
      })
      .catch((e) => {
        if (alive.current) setError(errorMessage(e))
      })
    return () => {
      alive.current = false
      if (running.current)
        void evidenceCommands.cancel(running.current).catch(() => {})
    }
  }, [reviewId])
  const prepare = async (command: string[]) => {
    try {
      setPermission(await evidenceCommands.prepare(reviewId, command))
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  const answer = async (approved: boolean) => {
    if (!permission) return
    const id = permission.id
    setPermission(null)
    setOutput("")
    setBusy(true)
    running.current = id
    try {
      const run = await evidenceCommands.answer(id, approved, (event) => {
        if (alive.current && running.current === event.runId)
          setOutput((value) => value + event.text)
      })
      if (alive.current)
        setRuns((values) => [run, ...values.filter((v) => v.id !== run.id)])
    } catch (e) {
      if (alive.current) setError(errorMessage(e))
    } finally {
      running.current = null
      if (alive.current) setBusy(false)
    }
  }
  const commands = [
    ["bun", "test"],
    ["cargo", "test"],
    ["npm", "test"],
  ]
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs text-muted-foreground">Evidence</h3>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="xs"
                className="-my-1 text-muted-foreground"
                disabled={busy}
              />
            }
          >
            <HugeiconsIcon icon={TestTube01Icon} />
            Run a test…
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Asks before running</DropdownMenuLabel>
              {commands.map((command) => (
                <DropdownMenuItem
                  key={command[0]}
                  className="font-mono text-xs"
                  onClick={() => void prepare(command)}
                >
                  {command.join(" ")}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {busy && (
        <div className="space-y-2 rounded-2xl border p-3">
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner className="size-3.5" />
            Running the approved command…
            <Button
              variant="ghost"
              size="xs"
              className="ml-auto"
              onClick={() => {
                if (running.current)
                  void evidenceCommands
                    .cancel(running.current)
                    .catch((e) => setError(errorMessage(e)))
              }}
            >
              Stop
            </Button>
          </p>
          <pre className="max-h-40 overflow-auto font-mono text-[11px] whitespace-pre-wrap text-muted-foreground">
            {output || "Waiting for output…"}
          </pre>
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {!busy && runs.length === 0 && (
        <Alert size="sm" variant="faded">
          <HugeiconsIcon icon={InformationCircleIcon} aria-hidden />
          <AlertTitle>No observed evidence yet.</AlertTitle>
          <AlertDescription>
            A test result is recorded with the exact command and whether the
            captured source still matched.
          </AlertDescription>
        </Alert>
      )}
      {runs.map((run) => {
        const outcome = evidenceOutcome(run, snapshotId)
        return (
          <Dialog key={run.id}>
            <DialogTrigger className="flex w-full items-start gap-2.5 rounded-2xl border bg-card px-3 py-2.5 text-left outline-none hover:bg-accent/40 focus-visible:ring-3 focus-visible:ring-ring/30">
              <HugeiconsIcon
                icon={
                  outcome.outdated ? ArrowReloadHorizontalIcon : TestTube01Icon
                }
                size={16}
                className={cn("mt-0.5 shrink-0", outcome.className)}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-xs">
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate font-mono",
                      outcome.outdated && "text-muted-foreground"
                    )}
                  >
                    {run.command.join(" ")}
                  </span>
                  <span
                    className={cn("shrink-0 font-medium", outcome.className)}
                  >
                    {outcome.label}
                  </span>
                </span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                  {outcome.detail}
                </span>
              </span>
            </DialogTrigger>
            <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-2xl">
              <DialogHeader className="shrink-0 pr-8">
                <DialogTitle className="wrap-anywhere">
                  {run.command.join(" ")}
                </DialogTitle>
                <DialogDescription>
                  {outcome.label} · {outcome.detail}
                </DialogDescription>
              </DialogHeader>
              <Separator />
              <pre className="min-h-0 overflow-auto font-mono text-xs wrap-anywhere whitespace-pre-wrap opacity-60">
                {run.output || "No command output."}
              </pre>
            </DialogContent>
          </Dialog>
        )
      })}
      <Dialog
        open={!!permission}
        onOpenChange={(open) => {
          if (!open) void answer(false)
        }}
      >
        <DialogContent>
          <DialogTitle>Allow this command once?</DialogTitle>
          <DialogDescription>
            It runs in your working directory and may write generated files. Its
            result is recorded as evidence and never validates code.
          </DialogDescription>
          <dl className="space-y-3 rounded-2xl bg-muted/60 p-4 text-xs">
            <div>
              <dt className="text-muted-foreground">Command</dt>
              <dd className="mt-1 font-mono break-all">
                {permission?.command.join(" ")}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Folder</dt>
              <dd className="mt-1 font-mono break-all">{permission?.cwd}</dd>
            </div>
          </dl>
          <DialogFooter>
            <Button variant="secondary" onClick={() => void answer(false)}>
              Deny
            </Button>
            <Button onClick={() => void answer(true)}>Allow once</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
