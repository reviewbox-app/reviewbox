"use client"
import { preparationCommands } from "../services/preparation.commands"
import { useCallback, useEffect, useRef, useState } from "react"
import type {
  AppError,
  PreparationState,
  Workspace,
} from "@/lib/desktop/contracts.generated"
import { appError } from "@/lib/desktop/diagnostics.helpers"
import {
  reviewCommands,
  desktopAvailable,
  errorMessage,
} from "@/lib/desktop/review.commands"
import type { PreparationProgress } from "../helpers/preparationProgress.helpers"
import {
  matchesReviewPreparation,
  reviewUpdateChanged,
  updateProgress,
} from "../helpers/reviewUpdate.helpers"

type View = {
  owner: string
  state: PreparationState | null
  progress: PreparationProgress | null
  message: string
  error: string
  errorDetails?: AppError
  pending: boolean
  readyId: string | null
}
const baseView = (view: View, owner: string): View =>
  view.owner === owner
    ? view
    : {
        owner,
        state: null,
        progress: null,
        message: "",
        error: "",
        pending: false,
        readyId: null,
      }
/** One observer for creation and adaptation. Only a newly requested creation may auto-start; existing jobs always require explicit resume. Leaving the screen never cancels native work. */
export function useReviewUpdate(
  workspace: Workspace | null,
  provider: string,
  onApplied: (workspace: Workspace) => void,
  create = false
) {
  const owner = workspace
    ? `${workspace.review.repositoryId}/${workspace.review.id}`
    : ""
  const current = useRef({ workspace, owner, onApplied })
  const [view, setView] = useState<View>({
    owner,
    state: null,
    progress: null,
    message: "",
    error: "",
    pending: false,
    readyId: null,
  })
  const operation = useRef(false)
  const seen = useRef<PreparationState | null>(null)
  const installed = useRef<string | null>(null)
  const sequence = useRef(0)
  const requests = useRef(0)
  const observed = useRef<string | null>(null)
  useEffect(() => {
    current.current = { workspace, owner, onApplied }
  }, [workspace, owner, onApplied])
  const receive = useCallback(
    async (value: PreparationState, ticket: string) => {
      const context = current.current
      if (
        context.owner !== ticket ||
        !context.workspace ||
        !matchesReviewPreparation(value, context.workspace)
      )
        return
      if (
        seen.current?.id === value.id &&
        Number(value.updatedAt) < Number(seen.current.updatedAt)
      )
        return
      if (value.status === "running") observed.current = value.id
      if (seen.current?.id !== value.id) sequence.current = 0
      seen.current = value
      sequence.current = Math.max(
        0,
        ...value.events.map((event) => event.sequence),
        sequence.current
      )
      setView((old) => {
        if (
          old.owner === ticket &&
          !old.error &&
          !reviewUpdateChanged(old.state, value, old.progress?.sequence ?? 0)
        )
          return old
        return {
          ...baseView(old, ticket),
          owner: ticket,
          state: value,
          progress: updateProgress(
            old.owner === ticket ? old.progress : null,
            value
          ),
          error: "",
          errorDetails: undefined,
        }
      })
      if (
        value.status === "ready" &&
        (observed.current === value.id || !value.adaptation) &&
        installed.current !== value.id
      ) {
        const updated = await reviewCommands.load(
          value.adaptation?.destinationReviewId ?? value.reviewId,
          context.workspace.review.repositoryId
        )
        if (
          current.current.owner !== ticket ||
          current.current.workspace?.snapshot.id !==
            context.workspace.snapshot.id
        )
          return
        installed.current = value.id
        if (
          !value.adaptation ||
          updated.snapshot.id !== current.current.workspace?.snapshot.id ||
          updated.review.id !== current.current.workspace?.review.id
        )
          current.current.onApplied(updated)
        setView((old) => ({ ...old, readyId: value.id }))
      }
    },
    []
  )
  const repositoryId = workspace?.review.repositoryId
  const reviewId = workspace?.review.id
  const snapshotId = workspace?.snapshot.id
  useEffect(() => {
    if (!reviewId || !desktopAvailable()) return
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    sequence.current = 0
    seen.current = null
    installed.current = null
    observed.current = null
    const poll = async (initial = false) => {
      const epoch = requests.current
      try {
        let value = await preparationCommands.get(
          reviewId,
          sequence.current,
          repositoryId
        )
        if (alive && epoch === requests.current && !value && initial && create)
          value = await preparationCommands.start(reviewId, provider)
        if (alive && epoch === requests.current && value)
          await receive(value, owner)
      } catch (cause) {
        if (alive && epoch === requests.current)
          setView((old) => ({
            ...baseView(old, owner),
            error: errorMessage(cause),
            errorDetails: appError(cause),
          }))
      }
      if (alive) timer = setTimeout(() => void poll(), 800)
    }
    void poll(true)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [owner, reviewId, snapshotId, repositoryId, receive, create, provider])
  const mutate = useCallback(
    async (kind: "start" | "create" | "resume" | "cancel" | "discard") => {
      const context = current.current
      if (!context.workspace || operation.current) return
      operation.current = true
      requests.current++
      const ticket = context.owner
      const { review } = context.workspace
      setView((old) => ({
        ...baseView(old, ticket),
        owner: ticket,
        pending: true,
        error: "",
        errorDetails: undefined,
        message: "",
      }))
      try {
        if (kind === "cancel" || kind === "discard") {
          if (kind === "cancel")
            await preparationCommands.cancel(review.id, review.repositoryId)
          else
            await preparationCommands.discardUpdate(
              review.id,
              review.repositoryId
            )
          if (current.current.owner === ticket && kind === "discard") {
            seen.current = null
            sequence.current = 0
            setView((old) => ({
              ...old,
              state: null,
              progress: null,
              message: "Update discarded. Your review is unchanged.",
            }))
          }
        } else {
          const value =
            kind === "create"
              ? await preparationCommands.start(review.id, provider)
              : kind === "start"
                ? await preparationCommands.update(
                    review.id,
                    review.revision,
                    provider,
                    review.repositoryId
                  )
                : await preparationCommands.resume(
                    review.id,
                    review.repositoryId
                  )
          if (current.current.owner !== ticket) return
          if (value) {
            sequence.current = 0
            observed.current = value.id
            await receive(value, ticket)
          } else
            setView((old) => ({
              ...old,
              state: null,
              progress: null,
              message: "No changes to update. Rev was not called.",
            }))
        }
      } catch (cause) {
        if (current.current.owner === ticket)
          setView((old) => ({
            ...old,
            error: errorMessage(cause),
            errorDetails: appError(cause),
          }))
      } finally {
        requests.current++
        operation.current = false
        if (current.current.owner === ticket)
          setView((old) => ({ ...old, pending: false }))
      }
    },
    [provider, receive]
  )
  const openReview = async () => {
    const context = current.current
    const state = seen.current
    if (!context.workspace || !state?.adaptation || state.status !== "ready")
      return
    try {
      const value = await reviewCommands.load(
        state.adaptation.destinationReviewId,
        context.workspace.review.repositoryId
      )
      if (current.current.owner === context.owner)
        current.current.onApplied(value)
    } catch (cause) {
      if (current.current.owner === context.owner)
        setView((old) => ({
          ...old,
          error: errorMessage(cause),
          errorDetails: appError(cause),
        }))
    }
  }
  const completedFork =
    view.state?.status === "ready" &&
    view.state.adaptation?.destinationReviewId === workspace?.review.id &&
    view.owner.startsWith(`${workspace?.review.repositoryId}/`)
  const visible =
    (view.owner === owner || completedFork) &&
    (!view.state ||
      (workspace && matchesReviewPreparation(view.state, workspace)))
      ? view
      : {
          state: null,
          progress: null,
          message: "",
          error: "",
          pending: false,
          readyId: null,
        }
  return {
    ...visible,
    readyToOpen:
      visible.state?.status === "ready" &&
      (visible.readyId === visible.state.id || !!visible.state.adaptation),
    startCreation: () => mutate(seen.current?.canResume ? "resume" : "create"),
    openReview,
    needsOpen:
      !!visible.state?.adaptation &&
      visible.state.adaptation.destinationReviewId !== workspace?.review.id,
    active: visible.state?.status === "running",
    start: () => mutate("start"),
    resume: () => mutate("resume"),
    cancel: () => mutate("cancel"),
    discard: () => mutate("discard"),
  }
}
