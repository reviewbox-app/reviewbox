"use client"
import {
  hasSourceChanges,
  subscribeRepositoryReads,
} from "@/lib/desktop/repositoryReads"
import { useCallback, useEffect, useRef, useState } from "react"
import type { LocalGitState } from "@/lib/desktop/contracts.generated"
import { desktopAvailable, errorMessage } from "@/lib/desktop/review.commands"
import {
  sourceControlCommands as commands,
  pendingGitRefreshes,
} from "../services/source-control.commands"

/** One repository owner. Passive updates preserve component and overlay identities. */
export function useSourceControl(repositoryId: string | undefined) {
  const [state, setState] = useState<LocalGitState | null>(null)
  const [failure, setFailure] = useState<{
    repositoryId: string | undefined
    message: string
  } | null>(null)
  const [busyRepository, setBusyRepository] = useState<string | null>(null)
  const gate = useRef(new Set<string>())
  const fetching = useRef(pendingGitRefreshes)
  const generation = useRef(0)
  const mutations = useRef(new Map<string, Promise<boolean>>())
  const owner = useRef(repositoryId)
  const ownership = useRef(0)
  useEffect(() => {
    owner.current = repositoryId
    const session = ++ownership.current
    return () => {
      ownership.current = session + 1
      owner.current = undefined
    }
  }, [repositoryId])
  const setError = useCallback(
    (message: string) => {
      if (owner.current === repositoryId) setFailure({ repositoryId, message })
    },
    [repositoryId]
  )
  const install = useCallback((value: LocalGitState) => {
    if (owner.current !== value.repositoryId) return
    setState((previous) =>
      JSON.stringify(previous) === JSON.stringify(value) ? previous : value
    )
  }, [])
  const reload = useCallback(async () => {
    if (!repositoryId || !desktopAvailable()) return null
    const started = generation.current
    const value = await commands.state(repositoryId)
    if (started === generation.current && !gate.current.has(repositoryId))
      install(value)
    return value
  }, [repositoryId, install])
  const fetch = useCallback(
    async (force = false) => {
      if (
        !repositoryId ||
        gate.current.has(repositoryId) ||
        !desktopAvailable()
      )
        return
      const pending = fetching.current.get(repositoryId)
      if (pending) {
        if (force) setBusyRepository(repositoryId)
        try {
          await pending
        } finally {
          if (force && !gate.current.has(repositoryId))
            setBusyRepository((previous) =>
              previous === repositoryId ? null : previous
            )
        }
        return
      }
      if (force) setBusyRepository(repositoryId)
      const operation = (async () => {
        try {
          const value = await commands.fetch(repositoryId, force)
          generation.current++
          install(value)
        } catch (cause) {
          const busyElsewhere =
            cause &&
            typeof cause === "object" &&
            "code" in cause &&
            cause.code === "git_busy"
          if (force || !busyElsewhere) setError(errorMessage(cause))
        } finally {
          fetching.current.delete(repositoryId)
          if (force && !gate.current.has(repositoryId))
            setBusyRepository((previous) =>
              previous === repositoryId ? null : previous
            )
        }
      })()
      fetching.current.set(repositoryId, operation)
      return operation
    },
    [repositoryId, install, setError]
  )
  useEffect(() => {
    if (!repositoryId || !desktopAvailable()) return
    let alive = true
    let running = false
    let queued = false
    const refresh = async () => {
      if (!alive) return
      if (running) {
        queued = true
        return
      }
      if (
        document.visibilityState !== "visible" ||
        gate.current.has(repositoryId)
      )
        return
      running = true
      try {
        await reload()
      } catch (cause) {
        if (alive) setError(errorMessage(cause))
      } finally {
        running = false
        if (queued && alive) {
          queued = false
          void refresh()
        }
      }
    }
    void refresh()
    queueMicrotask(() => {
      if (alive) void fetch()
    })
    const unsubscribe = subscribeRepositoryReads(
      repositoryId,
      (change) => {
        if (hasSourceChanges(change)) void refresh()
      },
      () => void refresh()
    )
    const focus = () => {
      void fetch()
    }
    window.addEventListener("focus", focus)
    return () => {
      alive = false
      unsubscribe()
      window.removeEventListener("focus", focus)
    }
  }, [repositoryId, reload, fetch, setError])
  const mutate = useCallback(
    (work: () => Promise<LocalGitState>) => {
      if (!repositoryId) return Promise.resolve(false)
      const previous = mutations.current.get(repositoryId)
      const requestedOwner = ownership.current
      if (!previous) setError("")
      gate.current.add(repositoryId)
      setBusyRepository(repositoryId)
      generation.current++
      const operation = (async () => {
        await previous
        await fetching.current.get(repositoryId)
        if (
          owner.current !== repositoryId ||
          ownership.current !== requestedOwner
        )
          return false
        try {
          install(await work())
          return true
        } catch (cause) {
          setError(errorMessage(cause))
          const current = await commands.state(repositoryId).catch(() => null)
          if (current) install(current)
          return false
        }
      })()
      mutations.current.set(repositoryId, operation)
      void operation.finally(() => {
        if (mutations.current.get(repositoryId) !== operation) return
        mutations.current.delete(repositoryId)
        gate.current.delete(repositoryId)
        setBusyRepository((previous) =>
          previous === repositoryId ? null : previous
        )
      })
      return operation
    },
    [repositoryId, install, setError]
  )
  return {
    state: state?.repositoryId === repositoryId ? state : null,
    error:
      failure?.repositoryId === repositoryId ? (failure?.message ?? "") : "",
    setError,
    busy: busyRepository === repositoryId,
    reload,
    fetch,
    mutate,
  }
}
export type SourceControlSession = ReturnType<typeof useSourceControl>
