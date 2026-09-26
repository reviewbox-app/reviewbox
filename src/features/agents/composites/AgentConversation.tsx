"use client"
import { useEffect, useRef, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { ProposalDialog } from "./ProposalDialog"
import { agentCommands } from "../services/agent.commands"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import type {
  AgentRequest,
  Snapshot,
  AgentRun,
  Proposal,
} from "@/lib/desktop/contracts.generated"
import { errorMessage, reviewCommands } from "@/lib/desktop/review.commands"
export function AgentConversation({
  reviewId,
  snapshot,
  initialPath,
  onSave,
  actions = ["ask", "topics"],
  onApplied,
}: {
  reviewId: string
  snapshot: Snapshot
  initialPath?: string
  onSave?: (run: AgentRun) => void
  actions?: string[]
  onApplied?: () => void
}) {
  const [preview, setPreview] = useState<
    import("@/lib/desktop/contracts.generated").PromptPreview | null
  >(null)
  const [error, setError] = useState("")
  const [provider, setProvider] = useState("codex")
  const [action, setAction] = useState(actions[0])
  const [completed, setCompleted] = useState<AgentRun | null>(null)
  const [history, setHistory] = useState<AgentRun[]>([])
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [proposal, setProposal] = useState<Proposal | null>(null)
  useEffect(() => {
    let alive = true
    void Promise.all([
      agentCommands.settings(),
      reviewCommands.projectSettings(snapshot.repositoryId),
    ])
      .then(([value, project]) => {
        if (alive) setProvider(project.provider ?? value.defaultProvider)
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e))
      })
    Promise.all([
      agentCommands.history(reviewId),
      agentCommands.proposals(reviewId),
    ])
      .then(([runs, drafts]) => {
        if (alive) {
          setHistory(runs)
          setProposals(drafts)
        }
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e))
      })
    return () => {
      alive = false
    }
  }, [reviewId, snapshot.repositoryId])
  const [question, setQuestion] = useState("")
  const [paths, setPaths] = useState<string[]>(initialPath ? [initialPath] : [])
  const [output, setOutput] = useState("")
  const [status, setStatus] = useState("")
  const [active, setActive] = useState(false)
  const running = useRef<string | null>(null)
  const sequence = useRef(0)
  useEffect(
    () => () => {
      const id = running.current
      running.current = null
      if (id) void agentCommands.cancel(id).catch(() => {})
    },
    [reviewId, snapshot.id]
  )
  const start = async () => {
    if (running.current) return
    const id = crypto.randomUUID()
    running.current = id
    sequence.current = 0
    setActive(true)
    setError("")
    setOutput("")
    setCompleted(null)
    setStatus("Connecting…")
    const onEvent = (
      event: import("@/lib/desktop/contracts.generated").AgentEvent
    ) => {
      if (running.current !== event.runId || event.sequence <= sequence.current)
        return
      sequence.current = event.sequence
      if (event.kind === "delta") setOutput((text) => text + event.text)
      else setStatus(event.text || event.kind)
    }
    const request: AgentRequest = {
      id,
      reviewId,
      provider,
      action,
      request: question,
      paths,
    }
    try {
      const run = await agentCommands.start(request, onEvent)
      if (running.current === id) {
        setCompleted(run)
        setHistory((items) => [run, ...items])
        if (action !== "ask") {
          const draft = await agentCommands.proposal(run.id)
          setProposal(draft)
          setProposals((items) => [draft, ...items])
        }
      }
    } catch (e) {
      if (running.current === id) setError(errorMessage(e))
    } finally {
      if (running.current === id) {
        running.current = null
        setActive(false)
      }
    }
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2">
        {["codex", "claude"].map((value) => (
          <Button
            key={value}
            variant={provider === value ? "secondary" : "ghost"}
            size="sm"
            disabled={active}
            onClick={() => setProvider(value)}
          >
            {value === "codex" ? "Codex" : "Claude Code"}
          </Button>
        ))}
      </div>
      {actions.length > 1 && (
        <label className="space-y-2 text-xs">
          Action
          <select
            aria-label="Agent action"
            value={action}
            disabled={active}
            onChange={(e) => setAction(e.target.value)}
            className="block w-full rounded-lg border bg-background p-2"
          >
            {actions.map((value) => (
              <option key={value} value={value}>
                {{
                  ask: "Ask a question",
                  topics: "Propose review topics",
                  file: "Explain this file",
                  block: "Explain a block",
                  glossary: "Propose project definitions",
                  refresh: "Refresh the explanation",
                }[value] ?? value}
              </option>
            ))}
          </select>
        </label>
      )}
      <details className="rounded-xl border p-3 text-xs" open>
        <summary className="cursor-pointer font-medium">
          Context · {paths.length} files · snapshot {snapshot.id.slice(0, 6)}
        </summary>
        <p className="my-3 text-muted-foreground">
          Only the selected frozen file contents are sent. Environment files and
          private-key files are excluded.
        </p>
        <div className="max-h-36 space-y-2 overflow-auto">
          {[
            ...new Set([
              ...snapshot.files.map((f) => f.path),
              ...snapshot.changes.map((c) => c.path),
            ]),
          ]
            .map((path) => ({ path }))
            .map((file) => (
              <Label key={file.path} className="text-xs">
                <Checkbox
                  disabled={active}
                  checked={paths.includes(file.path)}
                  onCheckedChange={(checked) =>
                    setPaths(
                      checked
                        ? [...paths, file.path]
                        : paths.filter((path) => path !== file.path)
                    )
                  }
                />
                <span className="truncate">{file.path}</span>
              </Label>
            ))}
        </div>
      </details>
      <Button
        size="xs"
        variant="ghost"
        disabled={active || !paths.length}
        onClick={() =>
          void agentCommands
            .preview({
              id: crypto.randomUUID(),
              reviewId,
              provider,
              action,
              request: question,
              paths,
            })
            .then(setPreview)
            .catch((e) => setError(errorMessage(e)))
        }
      >
        Preview the exact prompt and context
      </Button>
      <Dialog
        open={!!preview}
        onOpenChange={(v) => {
          if (!v) setPreview(null)
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-auto sm:max-w-3xl">
          <DialogTitle>Context sent to the provider</DialogTitle>
          <DialogDescription>{preview?.sources.join(" · ")}</DialogDescription>
          <pre className="font-mono text-xs whitespace-pre-wrap">
            {preview?.text}
          </pre>
        </DialogContent>
      </Dialog>
      <Textarea
        value={question}
        disabled={active}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder="Ask about this code…"
        aria-label="Question for agent"
      />
      <div className="flex gap-2">
        <Button
          disabled={
            active || (action === "ask" && !question.trim()) || !paths.length
          }
          onClick={() => void start()}
        >
          Ask {provider === "codex" ? "Codex" : "Claude"}
        </Button>
        {active && (
          <Button
            variant="outline"
            onClick={() => {
              if (running.current)
                void agentCommands
                  .cancel(running.current)
                  .catch((e) => setError(errorMessage(e)))
            }}
          >
            Stop
          </Button>
        )}
      </div>
      {status && (
        <p role="status" className="text-xs text-muted-foreground">
          {status}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {output && (
        <article className="space-y-3">
          <p className="text-[11px] text-review-attention">
            Agent suggestion · unverified
          </p>
          <p className="text-sm leading-6 whitespace-pre-wrap">{output}</p>
          {onSave && completed?.action === "ask" && (
            <Button
              variant="outline"
              size="sm"
              disabled={active || completed.snapshotId !== snapshot.id}
              onClick={() => onSave(completed)}
            >
              Keep as a note
            </Button>
          )}
          {completed && completed.action !== "ask" && (
            <Button
              variant="outline"
              size="sm"
              disabled={active || completed.snapshotId !== snapshot.id}
              onClick={() =>
                void agentCommands
                  .proposal(completed.id)
                  .then(setProposal)
                  .catch((e) => setError(errorMessage(e)))
              }
            >
              Review proposal
            </Button>
          )}
        </article>
      )}
      {(proposals.some((p) => p.status === "pending") ||
        history.length > 0) && (
        <details className="space-y-3 rounded-xl border p-3 text-xs">
          <summary className="cursor-pointer">
            Previous responses and pending proposals
          </summary>
          {proposals
            .filter((p) => p.status === "pending")
            .map((p) => (
              <Button
                key={p.id}
                className="mt-2 w-full justify-start"
                variant="outline"
                size="sm"
                onClick={() => setProposal(p)}
              >
                {p.content.kind} ·{" "}
                {p.snapshotId === snapshot.id ? "Pending" : "Older snapshot"}
              </Button>
            ))}
          {history.map((run) => (
            <Button
              key={run.id}
              className="mt-2 w-full justify-start"
              variant="ghost"
              size="sm"
              disabled={active}
              onClick={() => {
                setCompleted(run.status === "completed" ? run : null)
                setOutput(run.output)
                setStatus(run.status)
                setError("")
              }}
            >
              {run.provider} · {run.action} · {run.status}
            </Button>
          ))}
        </details>
      )}
      {proposal && (
        <ProposalDialog
          key={proposal.id}
          proposal={proposal}
          onClose={() => {
            setProposal(null)
            void agentCommands
              .proposals(reviewId)
              .then(setProposals)
              .catch((e) => setError(errorMessage(e)))
          }}
          onAccepted={() => onApplied?.()}
        />
      )}
    </div>
  )
}
