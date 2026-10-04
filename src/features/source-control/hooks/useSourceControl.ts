"use client"
import { subscribeRepositoryReads } from "@/lib/desktop/repositoryReads"
import { useCallback, useEffect, useRef, useState } from "react"
import type { LocalGitState } from "@/lib/desktop/contracts.generated"
import { desktopAvailable, errorMessage } from "@/lib/desktop/review.commands"
import { sourceControlCommands as commands } from "../services/source-control.commands"

/** One repository owner. Passive updates preserve component and overlay identities. */
export function useSourceControl(repositoryId: string | undefined) {
  const [state, setState] = useState<LocalGitState | null>(null)
  const [failure, setFailure] = useState<{
    repositoryId: string | undefined
    message: string
  } | null>(null)
  const [busyRepository, setBusyRepository] = useState<string | null>(null)
  const gate = useRef(new Set<string>())
  const owner = useRef(repositoryId)
  useEffect(() => {
    owner.current = repositoryId
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
    const value = await commands.state(repositoryId)
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
      gate.current.add(repositoryId)
      setBusyRepository(repositoryId)
      try {
        install(await commands.fetch(repositoryId, force))
      } catch (cause) {
        const busyElsewhere =
          cause &&
          typeof cause === "object" &&
          "code" in cause &&
          cause.code === "git_busy"
        if (force || !busyElsewhere) setError(errorMessage(cause))
      } finally {
        gate.current.delete(repositoryId)
        setBusyRepository((previous) =>
          previous === repositoryId ? null : previous
        )
      }
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
    void fetch()
    const unsubscribe = subscribeRepositoryReads(
      repositoryId,
      () => void refresh()
    )
    const timer = setInterval(() => void refresh(), 30000)
    const focus = () => {
      void fetch()
      void refresh()
    }
    window.addEventListener("focus", focus)
    return () => {
      alive = false
      unsubscribe()
      clearInterval(timer)
      window.removeEventListener("focus", focus)
    }
  }, [repositoryId, reload, fetch, setError])
  const mutate = useCallback(
    async (work: () => Promise<LocalGitState>) => {
      if (!repositoryId || gate.current.has(repositoryId)) return false
      gate.current.add(repositoryId)
      setBusyRepository(repositoryId)
      setError("")
      try {
        install(await work())
        return true
      } catch (cause) {
        setError(errorMessage(cause))
        await reload().catch(() => {})
        return false
      } finally {
        gate.current.delete(repositoryId)
        setBusyRepository((previous) =>
          previous === repositoryId ? null : previous
        )
      }
    },
    [repositoryId, install, reload, setError]
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
