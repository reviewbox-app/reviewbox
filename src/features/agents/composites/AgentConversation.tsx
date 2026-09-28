"use client"
import { useEffect, useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  AiMagicIcon,
  ArrowRight01Icon,
  Copy01Icon,
  GitCommitIcon,
  SentIcon,
  StopIcon,
} from "@hugeicons/core-free-icons"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Kbd } from "@/components/ui/kbd"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import type {
  AgentEvent,
  AgentRequest,
  Snapshot,
  AgentRun,
  Proposal,
} from "@/lib/desktop/contracts.generated"
import { errorMessage, reviewCommands } from "@/lib/desktop/review.commands"
import { cn } from "@/lib/utils"
import { ProposalDialog } from "./ProposalDialog"
import { agentCommands } from "../services/agent.commands"
import { useProviderStatus } from "../hooks/useProviderStatus"
import { harnessNames } from "../hooks/useRevStatus"

const actionLabels: Record<string, string> = {
  file: "Explain this file",
  block: "Explain a block",
  glossary: "Suggest project definitions",
  refresh: "Refresh the explanation",
}

function RevHeader({ time }: { time?: string }) {
  return (
    <div className="flex items-center gap-2">
      <Avatar size="sm">
        <AvatarFallback>
          <HugeiconsIcon icon={AiMagicIcon} size={12} />
        </AvatarFallback>
      </Avatar>
      <span className="text-sm font-medium">Rev</span>
      <Badge variant="secondary">Suggestion</Badge>
      {time && <span className="text-xs text-muted-foreground">{time}</span>}
    </div>
  )
}

/** Code Explain generates structured explanations and glossary proposals. */
export function AgentConversation({
  reviewId,
  snapshot,
  initialPath,
  contextLabel,
  actions = ["file", "block", "glossary", "refresh"],
  onApplied,
  className,
}: {
  reviewId: string
  snapshot: Snapshot
  initialPath?: string
  /** Current reading position shown in the context, e.g. "Step 2 · validation.rs · 18–34". */
  contextLabel?: string
  actions?: string[]
  onApplied?: () => void
  className?: string
}) {
  const [error, setError] = useState("")
  const [provider, setProvider] = useState("codex")
  const providerStatus = useProviderStatus()
  const selectedStatus = providerStatus.providers.find(
    (p) => p.provider === provider
  )
  const providerReady =
    !providerStatus.checking && selectedStatus?.ready === true
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
  const [instructions, setInstructions] = useState("")
  const [asked, setAsked] = useState("")
  const paths = initialPath ? [initialPath] : []
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
  const stop = () => {
    if (running.current)
      void agentCommands
        .cancel(running.current)
        .catch((e) => setError(errorMessage(e)))
  }
  const request = (id: string): AgentRequest => ({
    id,
    reviewId,
    provider,
    action,
    request: instructions,
    paths,
  })
  const canSend = providerReady && !active
  const start = async () => {
    if (running.current || !canSend) return
    const id = crypto.randomUUID()
    running.current = id
    sequence.current = 0
    setActive(true)
    setError("")
    setOutput("")
    setCompleted(null)
    setAsked(actionLabels[action] ?? action)
    setInstructions("")
    setStatus("Connecting…")
    const onEvent = (event: AgentEvent) => {
      if (running.current !== event.runId || event.sequence <= sequence.current)
        return
      sequence.current = event.sequence
      if (event.kind === "delta") setOutput((text) => text + event.text)
      else if (event.kind !== "progress") setStatus(event.text || event.kind)
    }
    try {
      const run = await agentCommands.start(request(id), onEvent)
      if (running.current === id) {
        setOutput(run.output)
        setCompleted(run)
        setHistory((items) => [run, ...items])
        {
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
  const pending = proposals.filter((p) => p.status === "pending")
  return (
    <div
      className={cn("relative flex flex-col", className)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && active) {
          e.stopPropagation()
          stop()
        }
      }}
    >
      <div className="min-h-0 flex-1 space-y-5 overflow-auto px-5 pt-5 pb-44">
        <section className="space-y-2.5 rounded-2xl bg-muted/60 p-3">
          <h3 className="text-xs font-medium">Review context</h3>
          <div className="flex flex-wrap gap-1.5">
            {contextLabel && <Badge variant="secondary">{contextLabel}</Badge>}
            {paths.map((path) => (
              <Badge key={path} variant="secondary" title={path}>
                {path.split("/").at(-1)}
              </Badge>
            ))}
            <Badge variant="secondary">
              <HugeiconsIcon icon={GitCommitIcon} />
              snapshot {snapshot.id.slice(0, 6)}
            </Badge>
          </div>
        </section>
        {asked && (
          <article className="space-y-1">
            <div className="flex items-center gap-2">
              <Avatar size="sm">
                <AvatarFallback className="text-[10px]">RV</AvatarFallback>
              </Avatar>
              <span className="text-sm font-medium">You</span>
            </div>
            <p className="pl-8 text-sm leading-6 whitespace-pre-wrap">
              {asked}
            </p>
          </article>
        )}
        {(output || active) && (
          <article className="space-y-1">
            <RevHeader />
            <div className="space-y-3 pl-8">
              {output && (
                <p className="text-sm leading-6 whitespace-pre-wrap">
                  {output}
                </p>
              )}
              {active && (
                <p
                  role="status"
                  className="flex items-center gap-2 text-xs text-muted-foreground"
                >
                  <Spinner className="size-3.5" />
                  {status}
                  <Kbd>Esc</Kbd>
                </p>
              )}
              {completed && !active && (
                <div className="flex flex-wrap gap-1">
                  {
                    <Button
                      variant="secondary"
                      size="xs"
                      disabled={completed.snapshotId !== snapshot.id}
                      onClick={() =>
                        void agentCommands
                          .proposal(completed.id)
                          .then(setProposal)
                          .catch((e) => setError(errorMessage(e)))
                      }
                    >
                      Review proposal
                    </Button>
                  }
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => void navigator.clipboard?.writeText(output)}
                  >
                    <HugeiconsIcon icon={Copy01Icon} />
                    Copy
                  </Button>
                </div>
              )}
            </div>
          </article>
        )}
        {!asked && !output && !active && (
          <p className="text-sm leading-6 text-muted-foreground">
            Generate an explanation or project definitions from the captured
            code. Review the result before adding it to Code Explain.
          </p>
        )}
        {!providerReady && (
          <p
            role="status"
            className="rounded-2xl bg-muted p-3 text-sm wrap-anywhere text-muted-foreground"
          >
            {providerStatus.checking
              ? "Checking the harness version…"
              : (selectedStatus?.message ??
                (providerStatus.error ||
                  "Harness unavailable. Check Settings > Rev."))}
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="rounded-2xl bg-destructive/10 p-3 text-sm text-destructive"
          >
            {error}
          </p>
        )}
        {(pending.length > 0 || history.length > 0) && (
          <Collapsible>
            <CollapsibleTrigger className="group/earlier flex items-center gap-1 text-xs text-muted-foreground outline-none hover:text-foreground">
              <HugeiconsIcon
                icon={ArrowRight01Icon}
                size={14}
                className="transition-transform group-data-[panel-open]/earlier:rotate-90"
              />
              Earlier generations and pending proposals
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2 space-y-1">
              {pending.map((p) => (
                <Button
                  key={p.id}
                  className="w-full justify-start"
                  variant="secondary"
                  size="sm"
                  onClick={() => setProposal(p)}
                >
                  Proposal · {p.content.kind} ·{" "}
                  {p.snapshotId === snapshot.id ? "pending" : "older snapshot"}
                </Button>
              ))}
              {history.map((run) => (
                <Button
                  key={run.id}
                  className="w-full justify-start"
                  variant="ghost"
                  size="sm"
                  disabled={active}
                  onClick={() => {
                    setCompleted(run.status === "completed" ? run : null)
                    setAsked(actionLabels[run.action] ?? run.action)
                    setOutput(run.output)
                    setStatus(run.status)
                    setError("")
                  }}
                >
                  {actionLabels[run.action] ?? run.action} ·{" "}
                  {harnessNames[run.provider] ?? run.provider} · {run.status}
                </Button>
              ))}
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
      <footer className="absolute inset-x-0 bottom-0 border-t glass-bar p-3">
        <div className="rounded-3xl border bg-card/60 focus-within:border-ring">
          <Textarea
            value={instructions}
            disabled={active}
            onChange={(e) => setInstructions(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void start()
              }
            }}
            placeholder="Additional generation instructions (optional)…"
            aria-label="Generation instructions"
            className="max-h-40 min-h-12 bg-transparent px-3.5 pt-2.5 focus-visible:border-transparent focus-visible:ring-0"
          />
          <div className="flex items-center gap-2 p-2">
            {actions.length > 1 && (
              <NativeSelect
                size="sm"
                aria-label="What Rev should do"
                value={action}
                disabled={active}
                onChange={(e) => setAction(e.target.value)}
              >
                {actions.map((value) => (
                  <NativeSelectOption key={value} value={value}>
                    {actionLabels[value] ?? value}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            )}
            <NativeSelect
              size="sm"
              aria-label="Rev's harness"
              title="Harness used by Rev for this request"
              value={provider}
              disabled={active}
              onChange={(e) => setProvider(e.target.value)}
            >
              {Object.entries(harnessNames).map(([value, name]) => (
                <NativeSelectOption key={value} value={value}>
                  {name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <span className="flex-1" />
            {active ? (
              <Button variant="secondary" size="sm" onClick={stop}>
                <HugeiconsIcon icon={StopIcon} />
                Stop
              </Button>
            ) : (
              <Button
                size="icon-sm"
                aria-label="Generate explanation"
                disabled={!canSend}
                onClick={() => void start()}
              >
                <HugeiconsIcon icon={SentIcon} size={14} />
              </Button>
            )}
          </div>
        </div>
        <p className="mt-2 text-center text-xs text-muted-foreground">
          Generated explanations do not validate the review.
        </p>
      </footer>
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
