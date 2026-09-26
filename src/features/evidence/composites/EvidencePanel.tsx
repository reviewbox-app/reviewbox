"use client"
import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import type { TestRun } from "@/lib/desktop/contracts.generated"
import { errorMessage } from "@/lib/desktop/review.commands"
import { evidenceCommands } from "../services/evidence.commands"
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
  return (
    <section className="space-y-3">
      <h3 className="text-xs text-muted-foreground">Evidence</h3>
      <div className="flex flex-wrap gap-2">
        {[
          ["bun", "test"],
          ["cargo", "test"],
          ["npm", "test"],
        ].map((command) => (
          <Button
            key={command[0]}
            variant="outline"
            size="xs"
            disabled={busy}
            onClick={() => void prepare(command)}
          >
            {command.join(" ")}
          </Button>
        ))}
      </div>
      {busy && (
        <>
          <pre className="max-h-40 overflow-auto rounded-lg bg-background p-2 text-[10px] whitespace-pre-wrap">
            {output || "Running approved test…"}
          </pre>
          <Button
            variant="outline"
            size="xs"
            onClick={() => {
              if (running.current)
                void evidenceCommands
                  .cancel(running.current)
                  .catch((e) => setError(errorMessage(e)))
            }}
          >
            Stop test
          </Button>
        </>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {runs.map((run) => (
        <details key={run.id} className="rounded-xl border p-3 text-xs">
          <summary className="cursor-pointer">
            <span className="font-mono">{run.command.join(" ")}</span>
            <span className="ml-2 text-muted-foreground">
              {run.snapshotId !== snapshotId ? "Outdated" : run.status}
              {run.exitCode !== null ? ` · exit ${run.exitCode}` : ""}
            </span>
          </summary>
          <p className="my-3 text-muted-foreground">
            {run.snapshotMatches && run.snapshotId === snapshotId
              ? "Captured source matches before and after this run. Dependencies and ignored inputs are not verified."
              : "This result does not establish a match with the current snapshot."}
          </p>
          <pre className="max-h-64 overflow-auto font-mono text-[10px] whitespace-pre-wrap">
            {run.output || "No command output."}
          </pre>
        </details>
      ))}
      <Dialog
        open={!!permission}
        onOpenChange={(open) => {
          if (!open) void answer(false)
        }}
      >
        <DialogContent>
          <DialogTitle>Allow this test?</DialogTitle>
          <DialogDescription>
            The command runs in your usual working directory and may write
            generated files. Its result never validates code automatically.
          </DialogDescription>
          <pre className="rounded-xl border p-4 text-xs whitespace-pre-wrap">
            {permission?.command.join(" ")}
            {"\n\n"}
            {permission?.cwd}
          </pre>
          <DialogFooter>
            <Button variant="outline" onClick={() => void answer(false)}>
              Decline
            </Button>
            <Button onClick={() => void answer(true)}>Run once</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
