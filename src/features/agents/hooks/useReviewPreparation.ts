"use client"
import { useCallback, useEffect, useRef, useState } from "react"
import type {
  PreparationState,
  Workspace,
} from "@/lib/desktop/contracts.generated"
import { errorMessage } from "@/lib/desktop/review.commands"
import { preparationCommands } from "../services/preparation.commands"
import {
  beginProgress,
  finishProgress,
  receiveProgress,
  type PreparationProgress,
} from "../helpers/preparationProgress.helpers"

const phases = {
  context: "Preparing the captured context…",
  outline: "Exploring changes and choosing which files need pseudo-code…",
  documents: "Writing each step for all three reading levels…",
  files: "Preparing captured files…",
  pseudocode: "Translating captured file versions into pseudo-code…",
  checking: "Checking references and publishing the review…",
}

/** The screen subscribes; Rust owns execution and private checkpoints. */
export function useReviewPreparation(
  workspace: Workspace,
  provider: string,
  onApplied: () => void | Promise<void>
) {
  const [state, setState] = useState<PreparationState | null>(null)
  const [progress, setProgress] = useState<PreparationProgress | null>(null)
  const [error, setError] = useState("")
  const [pending, setPending] = useState(false)
  const [loadedReviewId, setLoadedReviewId] = useState<string | null>(null)
  const applied = useRef(onApplied)
  const identity = `${workspace.review.repositoryId}/${workspace.review.id}/${workspace.snapshot.id}`
  const [stateIdentity, setStateIdentity] = useState(identity)
  if (stateIdentity !== identity) {
    setStateIdentity(identity)
    setState(null)
    setProgress(null)
    setError("")
    setLoadedReviewId(null)
  }
  const owner = useRef(identity)
  const ready = useRef<string | null>(null)
  const sequence = useRef(0)
  const currentState = useRef<PreparationState | null>(null)
  const operation = useRef(false)
  useEffect(() => {
    applied.current = onApplied
  }, [onApplied])
  const receive = useCallback(
    (value: PreparationState) => {
      if (owner.current !== identity) return
      if (
        value.snapshotId !== workspace.snapshot.id ||
        value.reviewId !== workspace.review.id
      )
        return
      if (
        currentState.current &&
        Number(value.updatedAt) < Number(currentState.current.updatedAt)
      )
        return
      currentState.current = value
      setState(value)
      setProgress((old) => {
        let next =
          old?.runId === value.id
            ? old
            : beginProgress(value.id, Number(value.startedAt))
        if (value.status === "running" && next.outcome)
          next = { ...next, outcome: undefined, endedAt: undefined }
        for (const event of value.events) next = receiveProgress(next, event)
        sequence.current = next.sequence
        if (value.status !== "running")
          next = finishProgress(
            next,
            value.status === "ready"
              ? "completed"
              : value.status === "failed"
                ? "failed"
                : "cancelled",
            Number(value.updatedAt)
          )
        return next
      })
      if (value.status === "ready" && ready.current !== value.id) {
        ready.current = value.id
        const completionOwner = owner.current
        void Promise.resolve(applied.current())
          .then(() => {
            if (owner.current === completionOwner) {
              setLoadedReviewId(value.id)
              setError("")
            }
          })
          .catch((cause) => {
            if (owner.current === completionOwner) {
              ready.current = null
              setError(errorMessage(cause))
            }
          })
      }
    },
    [identity, workspace.review.id, workspace.snapshot.id]
  )
  useEffect(() => {
    owner.current = identity
    sequence.current = 0
    currentState.current = null
    ready.current = null
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (initial = false) => {
      try {
        let value = await preparationCommands.get(
          workspace.review.id,
          initial ? undefined : sequence.current
        )
        if (!alive) return
        // An existing interrupted job is displayed and waits for explicit resume.
        if (!value && initial)
          value = await preparationCommands.start(workspace.review.id, provider)
        if (alive && value) receive(value)
      } catch (cause) {
        if (alive) setError(errorMessage(cause))
      }
      if (alive) timer = setTimeout(() => void poll(), 800)
    }
    void poll(true)
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [identity, provider, receive, workspace.review.id])
  const mutate = useCallback(
    async (cancel = false) => {
      if (operation.current) return
      operation.current = true
      setPending(true)
      setError("")
      const requestOwner = identity
      try {
        if (cancel) {
          await preparationCommands.cancel(workspace.review.id)
          return
        }
        const value = currentState.current?.canResume
          ? await preparationCommands.resume(workspace.review.id)
          : await preparationCommands.start(workspace.review.id, provider)
        if (owner.current === requestOwner) receive(value)
      } catch (cause) {
        if (owner.current === requestOwner) setError(errorMessage(cause))
      } finally {
        operation.current = false
        if (owner.current === requestOwner) setPending(false)
      }
    },
    [identity, provider, receive, workspace.review.id]
  )
  return {
    state,
    progress,
    error: error || (state?.error ? errorMessage(state.error) : ""),
    pending,
    active: state?.status === "running",
    readyToOpen: state?.status === "ready" && loadedReviewId === state.id,
    start: () => mutate(),
    cancel: useCallback(() => {
      void mutate(true)
    }, [mutate]),
    status: state
      ? state.status === "ready"
        ? "Your review is ready."
        : phases[state.phase]
      : "Loading preparation…",
  }
}
