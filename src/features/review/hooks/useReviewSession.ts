"use client"
import { useCallback, useEffect, useRef, useState } from "react"
import type {
  CaptureRequest,
  CodeAnchor,
  Coverage,
  Repository,
  ReviewAction,
  ReadingPosition,
  Workspace,
} from "@/lib/desktop/contracts.generated"
import {
  desktopAvailable,
  errorMessage,
  reviewCommands,
  setActiveRepository,
} from "@/lib/desktop/review.commands"
import { useReviewWorkspaceStore } from "../stores/useReviewWorkspace.store"
import {
  anchorFor,
  nextReaderTarget,
  readingStep,
  readerIdentity,
  readerCursorKey,
  readingUnits,
} from "../helpers/review.helpers"

export function useReviewSession() {
  const [repositories, setRepositories] = useState<Repository[]>([])
  const [repository, setRepository] = useState<Repository | null>(null)
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [selected, setSelected] = useState<CodeAnchor | null>(null)
  const [coverage, setCoverage] = useState<Coverage | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [changed, setChanged] = useState(false)
  const refreshFreshness = useRef<() => Promise<void>>(async () => {})
  const [freshnessSnapshot, setFreshnessSnapshot] = useState<string | null>(
    null
  )
  const [staleStepIds, setStaleStepIds] = useState<string[]>([])
  const [newReview, setNewReview] = useState(false)
  const current = useRef<Workspace | null>(null)
  const generation = useRef(0)
  const writing = useRef(false)
  const mutations = useRef<Promise<void>>(Promise.resolve())
  const pendingPosition = useRef<{
    identity: string
    position: ReadingPosition
  } | null>(null)
  const { setSpace } = useReviewWorkspaceStore()
  const accept = useCallback((received: Workspace) => {
    const pending = pendingPosition.current
    const value =
      pending?.identity === readerIdentity(received)
        ? {
            ...received,
            review: { ...received.review, position: pending.position },
          }
        : received
    current.current = value
    setWorkspace(value)
    reviewCommands
      .coverage(value.review.id)
      .then((result) => {
        if (
          current.current &&
          readerIdentity(current.current) === readerIdentity(value) &&
          current.current.review.revision === value.review.revision
        )
          setCoverage(result)
      })
      .catch((e) => setError(errorMessage(e)))
  }, [])
  const acceptCurrent = useCallback(
    (value: Workspace) => {
      if (
        current.current &&
        readerIdentity(current.current) === readerIdentity(value) &&
        value.review.revision >= current.current.review.revision
      )
        accept(value)
    },
    [accept]
  )
  const install = useCallback(
    (value: Workspace, navigate = true) => {
      const sourceChanged =
        current.current?.review.id !== value.review.id ||
        current.current?.snapshot.id !== value.snapshot.id ||
        current.current?.review.preparationId !== value.review.preparationId
      pendingPosition.current = null
      accept(value)
      const position = value.review.position
      const c =
        value.snapshot.changes.find((c) => c.id === position.changeId) ??
        value.snapshot.changes[0]
      const p =
        c?.passages.find((p) => p.id === position.passageId) ?? c?.passages[0]
      setSelected(c && p ? anchorFor(value.snapshot, c.id, p) : null)
      if (sourceChanged) {
        setChanged(false)
        setFreshnessSnapshot(null)
        setStaleStepIds([])
      }
      if (navigate) setSpace("review")
    },
    [accept, setSpace]
  )
  useEffect(() => {
    if (!desktopAvailable()) return
    let alive = true
    reviewCommands
      .repositories()
      .then((v) => {
        if (alive) setRepositories(v)
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e))
      })
    return () => {
      alive = false
    }
  }, [])
  const open = useCallback(
    async (path: string) => {
      await mutations.current
      const request = ++generation.current
      setBusy(true)
      setError("")
      try {
        const repo = await reviewCommands.open(path)
        const reviews = await reviewCommands.reviews(repo.id)
        if (generation.current !== request) return
        setActiveRepository(repo.id)
        setRepository(repo)
        setRepositories(await reviewCommands.repositories())
        current.current = null
        setWorkspace(null)
        setSelected(null)
        if (reviews.length) {
          const latest = reviews.sort(
            (a, b) => Number(b.updatedAt) - Number(a.updatedAt)
          )[0]
          const value = await reviewCommands.load(latest.id)
          if (generation.current === request) install(value)
        } else {
          setNewReview(false)
          setSpace("review")
        }
      } catch (e) {
        if (generation.current === request) setError(errorMessage(e))
      } finally {
        if (generation.current === request) setBusy(false)
      }
    },
    [install, setSpace]
  )
  const choose = useCallback(async () => {
    try {
      const path = await reviewCommands.choose()
      if (path) await open(path)
    } catch (e) {
      setError(errorMessage(e))
    }
  }, [open])
  const load = useCallback(
    async (id: string) => {
      await mutations.current
      const request = ++generation.current
      setBusy(true)
      try {
        const value = await reviewCommands.load(id)
        if (request === generation.current) install(value)
      } catch (e) {
        setError(errorMessage(e))
      } finally {
        if (request === generation.current) setBusy(false)
      }
    },
    [install]
  )
  const create = useCallback(
    async (request: CaptureRequest) => {
      if (writing.current) return
      writing.current = true
      setBusy(true)
      setError("")
      const ticket = generation.current
      try {
        const value = await reviewCommands.create(request)
        if (ticket === generation.current) {
          install(value)
          setNewReview(false)
        }
      } catch (e) {
        setError(errorMessage(e))
      } finally {
        writing.current = false
        setBusy(false)
      }
    },
    [install]
  )
  const action = useCallback(
    (action: ReviewAction) => {
      if (writing.current) return Promise.resolve(false)
      const ownerIdentity = current.current
        ? readerIdentity(current.current)
        : null
      const owner = current.current?.review.id
      const epoch = generation.current
      if (!owner) return Promise.resolve(false)
      const task = mutations.current.then(async () => {
        const value = current.current
        if (
          !value ||
          readerIdentity(value) !== ownerIdentity ||
          value.review.id !== owner ||
          generation.current !== epoch
        )
          return false
        if (action.kind !== "savePosition") setBusy(true)
        try {
          const next = await reviewCommands.update(
            owner,
            value.review.revision,
            action
          )
          if (
            current.current &&
            readerIdentity(current.current) === ownerIdentity &&
            current.current.review.id === owner &&
            generation.current === epoch
          ) {
            if (next.review.id !== owner) install(next)
            else accept(next)
            return true
          }
          return false
        } catch (e) {
          setError(errorMessage(e))
          return false
        } finally {
          if (generation.current === epoch && action.kind !== "savePosition")
            setBusy(false)
        }
      })
      mutations.current = task.then(() => undefined)
      return task
    },
    [accept, install]
  )
  const selectPosition = useCallback(
    (position: ReadingPosition) => {
      const value = current.current
      if (!value) return
      const pending = { identity: readerIdentity(value), position }
      pendingPosition.current = pending
      accept(value)
      const change = value.snapshot.changes.find(
        (item) => item.id === position.changeId
      )
      const passage = change?.passages.find(
        (item) => item.id === position.passageId
      )
      setSelected(
        change && passage ? anchorFor(value.snapshot, change.id, passage) : null
      )
      void action({ kind: "savePosition", position }).then((saved) => {
        if (pendingPosition.current !== pending) return
        pendingPosition.current = null
        if (
          !saved &&
          current.current &&
          readerIdentity(current.current) === readerIdentity(value)
        ) {
          void reviewCommands
            .load(value.review.id)
            .then((latest) => {
              if (
                current.current &&
                readerIdentity(current.current) === readerIdentity(latest) &&
                !pendingPosition.current
              )
                accept(latest)
            })
            .catch((cause) => setError(errorMessage(cause)))
        }
      })
    },
    [accept, action]
  )
  const selectStep = useCallback(
    (stepId: string, anchor?: CodeAnchor) => {
      const value = current.current
      if (!value) return
      const unit = readingUnits(value).find(
        (item) => item.step.step.id === stepId
      )
      if (!unit) return
      const target = anchor ?? unit.anchors[0]
      selectPosition({
        ...value.review.position,
        context: "guided",
        stepId,
        changeId: target?.changeId ?? null,
        passageId: target?.passageId ?? null,
        line: 0,
        scrollTop: 0,
      })
    },
    [selectPosition]
  )
  const selectFile = useCallback(
    (fileId: string, changeId?: string) => {
      const value = current.current
      const file = value?.review.files.find((item) => item.id === fileId)
      if (!value || !file) return
      const change = value.snapshot.changes.find(
        (item) => item.id === (changeId ?? file.changeIds[0])
      )
      selectPosition({
        ...value.review.position,
        context: "files",
        fileId,
        changeId: change?.id ?? null,
        passageId: change?.passages[0]?.id ?? null,
        line: 0,
        scrollTop: 0,
      })
    },
    [selectPosition]
  )
  const selectView = useCallback(
    (view: "document" | "code") => {
      const value = current.current
      if (view === "document" && value?.review.position.context === "files") {
        // File exploration retains stepId as the independent guided cursor.
        // Returning to the explanation resumes that step, not the explored file.
        const units = readingUnits(value)
        const remembered =
          units.find(
            (item) => item.step.step.id === value.review.position.stepId
          ) ?? units[0]
        if (remembered) selectStep(remembered.step.step.id)
      }
      useReviewWorkspaceStore.getState().setView(view)
    },
    [selectStep]
  )
  const select = useCallback(
    (anchor: CodeAnchor, stepId?: string) => {
      if (stepId) selectStep(stepId, anchor)
      else {
        const file = current.current?.review.files.find((item) =>
          item.changeIds.includes(anchor.changeId)
        )
        if (file) selectFile(file.id, anchor.changeId)
      }
    },
    [selectStep, selectFile]
  )
  const isCurrentCursor = useCallback((key: string) => {
    return !!current.current && readerCursorKey(current.current) === key
  }, [])
  const next = useCallback(
    (direction: number) => {
      const value = current.current
      if (!value) return
      const target = nextReaderTarget(value, direction)
      if (target?.kind === "file") selectFile(target.fileId)
      else if (target?.kind === "step") selectStep(target.stepId)
    },
    [selectStep, selectFile]
  )
  const refresh = useCallback(async () => {
    if (writing.current) return
    writing.current = true
    await mutations.current
    const value = current.current
    if (!value) {
      writing.current = false
      return
    }
    setBusy(true)
    try {
      const next = await reviewCommands.refresh(
        value.review.id,
        value.review.revision
      )
      if (
        current.current &&
        readerIdentity(current.current) === readerIdentity(value)
      )
        install(next)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      writing.current = false
      setBusy(false)
    }
  }, [install])
  const watchedReviewId = workspace?.review.id
  const watchedRepositoryId = workspace?.review.repositoryId
  useEffect(() => {
    if (!watchedReviewId) return
    let alive = true
    let checking = false
    const check = async () => {
      if (checking || writing.current || document.visibilityState !== "visible")
        return
      checking = true
      const before = current.current
      try {
        const value = await reviewCommands.load(watchedReviewId)
        if (
          alive &&
          !writing.current &&
          current.current === before &&
          (value.review.revision !== before?.review.revision ||
            JSON.stringify(value.review.publication) !==
              JSON.stringify(before?.review.publication))
        ) {
          if (value.snapshot.id !== before?.snapshot.id) install(value, false)
          else accept(value)
        }
      } catch (e) {
        if (alive) setError(errorMessage(e))
      } finally {
        checking = false
      }
    }
    const timer = setInterval(check, 2000)
    window.addEventListener("focus", check)
    return () => {
      alive = false
      clearInterval(timer)
      window.removeEventListener("focus", check)
    }
  }, [watchedReviewId, watchedRepositoryId, accept, install])
  const watchedSnapshotId = workspace?.snapshot.id
  const watchedPreparationId = workspace?.review.preparationId
  useEffect(() => {
    if (!watchedSnapshotId || !watchedReviewId || !watchedRepositoryId) return
    let alive = true
    let checking = false
    const check = async (force = false) => {
      if (checking || (!force && document.visibilityState !== "visible")) return
      checking = true
      if (force) setFreshnessSnapshot(null)
      try {
        const value = await reviewCommands.freshness(
          watchedReviewId,
          watchedRepositoryId
        )
        if (alive && current.current?.snapshot.id === watchedSnapshotId) {
          setChanged(value.changed)
          setStaleStepIds((old) =>
            JSON.stringify(old) === JSON.stringify(value.staleStepIds)
              ? old
              : value.staleStepIds
          )
          setFreshnessSnapshot(watchedSnapshotId)
        }
      } catch (e) {
        if (alive) {
          setFreshnessSnapshot(null)
          setError(errorMessage(e))
        }
      } finally {
        checking = false
      }
    }
    const onFocus = () => void check(true)
    refreshFreshness.current = () => check(true)
    void check(true)
    window.addEventListener("focus", onFocus)
    const timer = setInterval(check, 30000)
    return () => {
      alive = false
      clearInterval(timer)
      window.removeEventListener("focus", onFocus)
    }
  }, [
    watchedSnapshotId,
    watchedRepositoryId,
    watchedReviewId,
    watchedPreparationId,
  ]) // Snapshot is immutable; revisions must not restart the watcher.
  const nextTopic = useCallback(
    (direction: number) => {
      if (!workspace) return
      const topics = workspace.review.topics
      const currentTopic = readingStep(workspace.review)?.topic.id
      const index = topics.findIndex((t) => t.id === currentTopic)
      const topic =
        topics[Math.max(0, Math.min(topics.length - 1, index + direction))]
      const step = topic?.steps.find((s) =>
        s.anchors.some((a) => a.snapshotId === workspace.snapshot.id)
      )
      const anchor = step?.anchors.find(
        (a) => a.snapshotId === workspace.snapshot.id
      )
      if (step && anchor) selectStep(step.id, anchor)
    },
    [workspace, selectStep]
  )
  const home = useCallback(async () => {
    await mutations.current
    generation.current++
    current.current = null
    setActiveRepository(null)
    setRepository(null)
    setWorkspace(null)
    setSelected(null)
    pendingPosition.current = null
    setNewReview(false)
    setBusy(false)
  }, [])
  return {
    repositories,
    repository,
    workspace,
    selected,
    coverage,
    busy,
    error,
    changed,
    staleStepIds,
    checkFreshness: () => refreshFreshness.current(),
    freshnessChecked: freshnessSnapshot === workspace?.snapshot.id,
    newReview,
    setNewReview,
    setError,
    open,
    choose,
    load,
    create,
    action,
    select,
    selectStep,
    selectFile,
    selectView,
    next,
    isCurrentCursor,
    nextTopic,
    refresh,
    home,
    install,
    accept,
    acceptCurrent,
    deleted: (id: string) => {
      if (current.current?.review.id !== id) return
      generation.current++
      current.current = null
      setWorkspace(null)
      setSelected(null)
      setCoverage(null)
      setChanged(false)
      setBusy(false)
    },
    forget: async (id: string) => {
      try {
        await reviewCommands.forget(id)
        setRepositories(await reviewCommands.repositories())
      } catch (e) {
        setError(errorMessage(e))
      }
    },
  }
}
