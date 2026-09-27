"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type {
  AgentPreparationContext,
  AgentRequest,
  Proposal,
  Topic,
  Workspace,
} from "@/lib/desktop/contracts.generated"
import { errorMessage, reviewCommands } from "@/lib/desktop/review.commands"
import { agentCommands } from "../services/agent.commands"
import {
  beginProgress,
  finishProgress,
  receiveProgress,
  type PreparationProgress,
} from "../helpers/preparationProgress.helpers"
import type {
  PreparationPhase,
  PreparedTopic,
  TopicChoice,
} from "../contracts/preparation.types"

export function useReviewPreparation(
  workspace: Workspace,
  provider: string,
  onApplied: () => void | Promise<void>,
  onDone: () => void
) {
  const [context, setContext] = useState<AgentPreparationContext | null>(null)
  const [phase, setPhase] = useState<PreparationPhase>("loading")
  const [status, setStatus] = useState("Preparing project exploration…")
  const [error, setError] = useState("")
  const [topics, setTopics] = useState<PreparedTopic[]>([])
  const [progress, setProgress] = useState<PreparationProgress | null>(null)
  const [active, setActive] = useState(false)
  const [loadVersion, setLoadVersion] = useState(0)
  const running = useRef<{
    id: string
    cancelled: boolean
    started: boolean
  } | null>(null)
  const proposal = useRef<Proposal | null>(null)
  const applying = useRef(false)
  const mounted = useRef(false)
  const identity = `${workspace.review.id}/${workspace.snapshot.id}/${provider}`
  const currentIdentity = useRef(identity)
  const [stateIdentity, setStateIdentity] = useState(identity)
  // A refreshed snapshot is a new preparation owner. Clear visible drafts in
  // the same render so the previous snapshot is never offered for acceptance.
  if (stateIdentity !== identity) {
    setStateIdentity(identity)
    setContext(null)
    setProgress(null)
    setTopics([])
    setError("")
    setPhase("loading")
    setStatus("Preparing project exploration…")
    setActive(false)
  }

  const start = useCallback(async () => {
    if (running.current || !mounted.current) return
    const owner = currentIdentity.current
    const operation = {
      id: crypto.randomUUID(),
      cancelled: false,
      started: false,
    }
    const current = () =>
      mounted.current &&
      owner === currentIdentity.current &&
      running.current === operation
    running.current = operation
    setProgress(beginProgress(operation.id))
    setActive(true)
    setError("")
    setTopics([])
    proposal.current = null
    setPhase("running")
    setStatus("Preparing review instructions…")
    const request: AgentRequest = {
      id: operation.id,
      reviewId: workspace.review.id,
      provider,
      action: "topics",
      request: "",
      paths: [],
    }
    let sequence = 0
    let cancellationRetried = false
    try {
      const statuses = await reviewCommands.providers()
      if (!current() || operation.cancelled) return
      const harness = statuses.find((item) => item.provider === provider)
      if (!harness?.ready)
        throw new Error(
          harness?.message || "This harness is not ready. Check Settings > Rev."
        )
      setStatus("Connecting to the harness…")
      operation.started = true
      const run = await agentCommands.start(request, (event) => {
        if (event.runId !== operation.id) return
        if (!current() || operation.cancelled) {
          // Cancellation can reach Rust before start_agent registers. The
          // first event proves registration happened, so cancel once again.
          if (!cancellationRetried) {
            cancellationRetried = true
            void agentCommands.cancel(operation.id).catch(() => {})
          }
          return
        }
        if (event.sequence <= sequence) return
        sequence = event.sequence
        setProgress((state) => (state ? receiveProgress(state, event) : state))
        if (event.kind === "delta")
          setStatus("Rev is writing suggested topics…")
        else if (event.kind !== "completed" && event.kind !== "progress")
          setStatus(event.text || event.kind)
      })
      if (!current() || operation.cancelled) return
      setProgress((state) =>
        state ? finishProgress(state, "completed") : state
      )
      setPhase("checking")
      setStatus("Checking anchors against the frozen files…")
      const draft = await agentCommands.proposal(run.id)
      if (!current() || operation.cancelled) return
      if (draft.content.kind !== "topics")
        throw new Error("Rev did not return a topic proposal.")
      const diagnostics = await agentCommands.diagnose(
        workspace.review.id,
        draft.content
      )
      if (!current() || operation.cancelled) return
      proposal.current = draft
      setTopics(
        draft.content.topics.map((topic, index) => ({
          topic,
          choice: "pending",
          diagnostics: diagnostics.filter((item) => item.topicIndex === index),
        }))
      )
      setStatus(
        diagnostics.length
          ? "Some anchors need your attention."
          : "All proposed anchors match the review files."
      )
      setPhase("suggestions")
    } catch (cause) {
      if (current() && !operation.cancelled) {
        setProgress((state) =>
          state ? finishProgress(state, "failed") : state
        )
        setError(errorMessage(cause))
        setPhase("error")
        setStatus("Preparation could not finish.")
      }
    } finally {
      if (current()) {
        running.current = null
        setActive(false)
        if (operation.cancelled) setPhase("cancelled")
      }
    }
  }, [provider, workspace.review.id])

  useEffect(() => {
    mounted.current = true
    currentIdentity.current = identity
    proposal.current = null
    applying.current = false
    let alive = true
    void agentCommands
      .preparationContext(workspace.review.id)
      .then((value) => {
        if (!alive || value.snapshotId !== workspace.snapshot.id) return
        setContext(value)
        void start()
      })
      .catch((cause) => {
        if (alive) {
          setError(errorMessage(cause))
          setPhase("error")
        }
      })
    return () => {
      alive = false
      mounted.current = false
      const operation = running.current
      running.current = null
      if (operation) {
        operation.cancelled = true
        if (operation.started)
          void agentCommands.cancel(operation.id).catch(() => {})
      }
    }
  }, [identity, start, workspace.review.id, workspace.snapshot.id, loadVersion])

  const cancel = useCallback(() => {
    const operation = running.current
    if (!operation) return
    operation.cancelled = true
    setProgress((state) => (state ? finishProgress(state, "cancelled") : state))
    setStatus("Stopping Rev…")
    setPhase("cancelled")
    if (operation.started)
      void agentCommands.cancel(operation.id).catch((cause) => {
        if (mounted.current) setError(errorMessage(cause))
      })
  }, [])

  const choose = (id: string, choice: TopicChoice) =>
    setTopics((items) =>
      items.map((item) => (item.topic.id === id ? { ...item, choice } : item))
    )
  const edit = async (topic: Topic) => {
    const owner = currentIdentity.current
    if (!topics.some((item) => item.topic.id === topic.id))
      throw new Error(
        "This proposal changed. Close the editor and reopen the current topic."
      )
    const next = topics.map((item) =>
      item.topic.id === topic.id
        ? { ...item, topic, choice: "pending" as const }
        : item
    )
    const diagnostics = await agentCommands.diagnose(workspace.review.id, {
      kind: "topics",
      topics: next.map((item) => item.topic),
    })
    if (mounted.current && currentIdentity.current === owner)
      setTopics(
        next.map((item, index) => ({
          ...item,
          diagnostics: diagnostics.filter(
            (diagnostic) => diagnostic.topicIndex === index
          ),
        }))
      )
  }
  const accepted = topics.filter((item) => item.choice === "accepted")
  const apply = async () => {
    const draft = proposal.current
    const owner = currentIdentity.current
    const current = () => mounted.current && currentIdentity.current === owner
    if (
      !draft ||
      !accepted.length ||
      accepted.some((item) => item.diagnostics.length) ||
      applying.current
    )
      return
    applying.current = true
    setPhase("applying")
    setError("")
    try {
      await agentCommands.answer(
        draft.id,
        draft.revision,
        { kind: "topics", topics: accepted.map((item) => item.topic) },
        true
      )
      if (!current()) return
      proposal.current = null
      setPhase("complete")
      await onApplied()
      if (current()) onDone()
    } catch (cause) {
      if (current()) {
        setError(errorMessage(cause))
        setPhase(proposal.current ? "suggestions" : "complete")
      }
    } finally {
      if (current()) applying.current = false
    }
  }
  return {
    context,
    progress,
    retryContext: () => {
      setError("")
      setPhase("loading")
      setLoadVersion((value) => value + 1)
    },
    phase,
    status,
    error,
    topics,
    active,
    acceptedCount: accepted.length,
    canStart: !active && !!context,
    canApply:
      phase === "suggestions" &&
      accepted.length > 0 &&
      !accepted.some((item) => item.diagnostics.length),
    start,
    cancel,
    choose,
    edit,
    apply,
    rejectRemaining: () =>
      setTopics((items) =>
        items.map((item) =>
          item.choice === "pending" ? { ...item, choice: "rejected" } : item
        )
      ),
  }
}
