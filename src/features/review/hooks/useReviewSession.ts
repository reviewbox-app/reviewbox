"use client"
import { useCallback, useEffect, useRef, useState } from "react"
import type {
  CaptureRequest,
  CodeAnchor,
  Coverage,
  Repository,
  ReviewAction,
  Workspace,
} from "@/lib/desktop/contracts.generated"
import {
  desktopAvailable,
  errorMessage,
  reviewCommands,
  setActiveRepository,
} from "@/lib/desktop/review.commands"
import { useReviewWorkspaceStore } from "../stores/useReviewWorkspace.store"
import { anchorFor } from "../helpers/review.helpers"

export function useReviewSession() {
  const [repositories, setRepositories] = useState<Repository[]>([])
  const [repository, setRepository] = useState<Repository | null>(null)
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [selected, setSelected] = useState<CodeAnchor | null>(null)
  const [coverage, setCoverage] = useState<Coverage | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [changed, setChanged] = useState(false)
  const [newReview, setNewReview] = useState(false)
  const current = useRef<Workspace | null>(null)
  const generation = useRef(0)
  const writing = useRef(false)
  const mutations = useRef<Promise<void>>(Promise.resolve())
  const { setSpace, setCoverage: showCoverage } = useReviewWorkspaceStore()
  const accept = useCallback((value: Workspace) => {
    current.current = value
    setWorkspace(value)
    reviewCommands
      .coverage(value.review.id)
      .then((result) => {
        if (
          current.current?.review.id === value.review.id &&
          current.current.review.revision === value.review.revision
        )
          setCoverage(result)
      })
      .catch((e) => setError(errorMessage(e)))
  }, [])
  const install = useCallback(
    (value: Workspace) => {
      accept(value)
      const position = value.review.position
      const c =
        value.snapshot.changes.find((c) => c.id === position.changeId) ??
        value.snapshot.changes[0]
      const p =
        c?.passages.find((p) => p.id === position.passageId) ?? c?.passages[0]
      setSelected(c && p ? anchorFor(value.snapshot, c.id, p) : null)
      setChanged(false)
      setSpace("review")
      showCoverage(false)
    },
    [accept, setSpace, showCoverage]
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
          setNewReview(true)
        }
      } catch (e) {
        if (generation.current === request) setError(errorMessage(e))
      } finally {
        if (generation.current === request) setBusy(false)
      }
    },
    [install]
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
      const owner = current.current?.review.id
      const epoch = generation.current
      if (!owner) return Promise.resolve(false)
      const task = mutations.current.then(async () => {
        const value = current.current
        if (!value || value.review.id !== owner || generation.current !== epoch)
          return false
        if (action.kind !== "savePosition") setBusy(true)
        try {
          const next = await reviewCommands.update(
            owner,
            value.review.revision,
            action
          )
          if (
            current.current?.review.id === owner &&
            generation.current === epoch
          )
            accept(next)
          return true
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
    [accept]
  )
  const select = useCallback(
    (anchor: CodeAnchor, stepId?: string) => {
      setSelected(anchor)
      showCoverage(false)
      const value = current.current
      if (value && anchor.snapshotId === value.snapshot.id)
        void action({
          kind: "savePosition",
          position: {
            ...value.review.position,
            changeId: anchor.changeId,
            passageId: anchor.passageId,
            stepId: stepId ?? null,
            line: 0,
            scrollTop: 0,
          },
        })
    },
    [action, showCoverage]
  )
  const next = useCallback(
    (direction: number) => {
      if (!workspace) return
      const anchors = workspace.snapshot.changes.flatMap((c) =>
        c.passages.map((p) => anchorFor(workspace.snapshot, c.id, p))
      )
      const index = anchors.findIndex(
        (a) => a.passageId === selected?.passageId
      )
      const anchor =
        anchors[Math.max(0, Math.min(anchors.length - 1, index + direction))]
      if (anchor) select(anchor)
    },
    [workspace, selected, select]
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
      if (current.current?.review.id === value.review.id) install(next)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      writing.current = false
      setBusy(false)
    }
  }, [install])
  const watchedReviewId = workspace?.review.id
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
          value.review.revision !== before?.review.revision
        ) {
          if (value.snapshot.id !== before?.snapshot.id) install(value)
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
  }, [watchedReviewId, accept, install])
  const watchedSnapshotId = workspace?.snapshot.id
  useEffect(() => {
    if (!watchedSnapshotId) return
    let alive = true
    let checking = false
    const check = async () => {
      if (checking || document.visibilityState !== "visible") return
      checking = true
      try {
        const value = await reviewCommands.changed(watchedSnapshotId)
        if (alive) setChanged(value)
      } catch (e) {
        if (alive) setError(errorMessage(e))
      } finally {
        checking = false
      }
    }
    void check()
    window.addEventListener("focus", check)
    const timer = setInterval(check, 30000)
    return () => {
      alive = false
      clearInterval(timer)
      window.removeEventListener("focus", check)
    }
  }, [watchedSnapshotId]) // Snapshot is immutable; revisions must not restart the watcher.
  const home = useCallback(async () => {
    await mutations.current
    generation.current++
    current.current = null
    setActiveRepository(null)
    setRepository(null)
    setWorkspace(null)
    setSelected(null)
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
    newReview,
    setNewReview,
    setError,
    open,
    choose,
    load,
    create,
    action,
    select,
    next,
    refresh,
    home,
    install,
    accept,
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
