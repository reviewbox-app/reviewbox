"use client"
import { useEffect, useRef, useState } from "react"
import type {
  ProviderSetupEvent,
  ProviderStatus,
} from "@/lib/desktop/contracts.generated"
import { errorMessage } from "@/lib/desktop/review.commands"
import { setupCommands } from "../services/setup.commands"

/** A settings-owned installation. Closing its dialog cancels the native process. */
export function useHarnessUpdate() {
  const alive = useRef(true)
  const operation = useRef<{ id: string; cancelled: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [event, setEvent] = useState<ProviderSetupEvent | null>(null)
  const [error, setError] = useState("")
  const [completed, setCompleted] = useState(false)
  const cancel = async () => {
    const current = operation.current
    if (!current) return
    current.cancelled = true
    try {
      await setupCommands.cancel(current.id)
    } catch (e) {
      if (alive.current) setError(errorMessage(e))
    }
  }
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      const current = operation.current
      if (current) {
        current.cancelled = true
        void setupCommands.cancel(current.id).catch(() => {})
      }
    }
  }, [])
  const start = async (status: ProviderStatus) => {
    if (operation.current) return
    setEvent(null)
    setError("")
    setCompleted(false)
    if (!status.installation.canRun) {
      setError(status.installation.message)
      return
    }
    const current = { id: crypto.randomUUID(), cancelled: false }
    operation.current = current
    setBusy(true)
    try {
      await setupCommands.install(status.provider, current.id, (next) => {
        // Also catch cancellation that raced the native operation's registration.
        if (current.cancelled || !alive.current)
          void setupCommands.cancel(current.id).catch(() => {})
        if (alive.current && operation.current === current) setEvent(next)
      })
      if (alive.current) setCompleted(true)
    } catch (e) {
      if (alive.current) setError(errorMessage(e))
    } finally {
      operation.current = null
      if (alive.current) setBusy(false)
    }
  }
  return { busy, event, error, completed, start, cancel }
}
