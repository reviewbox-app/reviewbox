"use client"
import { useCallback, useEffect, useRef, useState } from "react"
import { listen } from "@tauri-apps/api/event"
import type { ProviderModel } from "@/lib/desktop/contracts.generated"
import { errorMessage } from "@/lib/desktop/review.commands"
import { agentCommands } from "../services/agent.commands"

/** A settings editor owns its catalog and subprocess, never the project files. */
export function useProviderModels(provider: string, executable?: string) {
  const key = `${provider}:${executable ?? ""}`
  const sequence = useRef(0)
  const request = useRef<string | null>(null)
  const cached = useRef<{ key: string; models: ProviderModel[] } | null>(null)
  const expanded = useRef(false)
  const [open, setOpen] = useState(false)
  const [state, setState] = useState({
    key: "",
    models: null as ProviderModel[] | null,
    loading: false,
    error: "",
  })
  const cancel = useCallback(() => {
    sequence.current++
    const id = request.current
    request.current = null
    if (id) void agentCommands.cancelModels(id).catch(() => {})
  }, [])
  const load = useCallback(
    async (force = false) => {
      if (!provider) return
      if (force) cached.current = null
      if (!force && cached.current?.key === key) {
        setState({
          key,
          models: cached.current.models,
          loading: false,
          error: "",
        })
        return
      }
      cancel()
      const current = sequence.current
      const id = crypto.randomUUID()
      request.current = id
      setState({ key, models: null, loading: true, error: "" })
      try {
        const models = await agentCommands.models(id, provider)
        if (current !== sequence.current) return
        cached.current = { key, models }
        setState({ key, models, loading: false, error: "" })
      } catch (error) {
        if (current === sequence.current)
          setState({
            key,
            models: null,
            loading: false,
            error: errorMessage(error),
          })
      } finally {
        if (request.current === id) request.current = null
      }
    },
    [cancel, key, provider]
  )
  useEffect(() => {
    if (expanded.current) void load()
    const invalidate = () => {
      cached.current = null
      cancel()
      setState({ key, models: null, loading: false, error: "" })
      if (expanded.current) void load(true)
    }
    const unsubscribe = listen("reviewbox:providers-changed", invalidate).catch(
      () => () => {}
    )
    return () => {
      cancel()
      void unsubscribe.then((stop) => stop())
    }
  }, [cancel, key, load])
  const onOpenChange = (next: boolean) => {
    expanded.current = next
    setOpen(next)
    if (next) void load()
    else if (request.current) {
      cancel()
      setState((previous) => ({ ...previous, loading: false }))
    }
  }
  return {
    open,
    onOpenChange,
    models: state.key === key ? state.models : null,
    loading: state.key === key && state.loading,
    error: state.key === key ? state.error : "",
    reload: () => void load(true),
  }
}
