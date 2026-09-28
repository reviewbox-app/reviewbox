"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type {
  LanguageServerCatalogue,
  Repository,
} from "@/lib/desktop/contracts.generated"
import { errorMessage, reviewCommands } from "@/lib/desktop/review.commands"
import { catalogueCommands } from "../services/catalogue.commands"
import { recommendedServers } from "../helpers/languageCatalogue.helpers"

export function useLanguageCatalogue() {
  const [catalogue, setCatalogue] = useState<LanguageServerCatalogue | null>(
    null
  )
  const [repositories, setRepositories] = useState<Repository[]>([])
  const [repositoryId, setRepositoryId] = useState("")
  const [paths, setPaths] = useState<string[]>([])
  const [error, setError] = useState("")
  const [busy, setBusy] = useState<string[]>([])
  const alive = useRef(false)
  const refreshing = useRef(false)
  const refresh = useCallback(async () => {
    if (refreshing.current) return
    refreshing.current = true
    try {
      const result = await catalogueCommands.read()
      if (alive.current) setCatalogue(result)
    } catch (error) {
      if (alive.current) setError(errorMessage(error))
    } finally {
      refreshing.current = false
    }
  }, [])
  useEffect(() => {
    alive.current = true
    void Promise.resolve().then(refresh)
    void reviewCommands
      .repositories()
      .then((items) => {
        if (!alive.current) return
        setRepositories(items)
        setRepositoryId(items[0]?.id ?? "")
      })
      .catch((error) => {
        if (alive.current) setError(errorMessage(error))
      })
    const timer = setInterval(() => void refresh(), 1500)
    return () => {
      alive.current = false
      clearInterval(timer)
    }
  }, [refresh])
  useEffect(() => {
    let current = true
    if (repositoryId)
      void catalogueCommands
        .paths(repositoryId)
        .then((items) => {
          if (current) setPaths(items)
        })
        .catch((error) => {
          if (current) setError(errorMessage(error))
        })
    return () => {
      current = false
    }
  }, [repositoryId])
  const recommended = useMemo(
    () => recommendedServers(catalogue?.entries ?? [], paths),
    [catalogue, paths]
  )
  const act = async (id: string, task: () => Promise<unknown>) => {
    setBusy((items) => [...items, id])
    setError("")
    try {
      await task()
      await refresh()
    } catch (error) {
      if (alive.current) setError(errorMessage(error))
    } finally {
      if (alive.current) setBusy((items) => items.filter((item) => item !== id))
    }
  }
  return {
    catalogue,
    repositories,
    repositoryId,
    setRepositoryId,
    recommended,
    error,
    busy,
    act,
  }
}
