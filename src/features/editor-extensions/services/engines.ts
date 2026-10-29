import { create } from "zustand"
import { useEffect } from "react"
import { listen } from "@tauri-apps/api/event"
import {
  call,
  desktopAvailable,
  errorMessage,
} from "@/lib/desktop/review.commands"
import type {
  LanguageServerCatalogue,
  LanguageServerInstallOperation,
} from "@/lib/desktop/contracts.generated"
import { extensionEnabled, extensions } from "./extensions.store"

export type EngineState = {
  phase: "installing" | "ready" | "failed"
  message: string
}
export const useEditorEngines = create<{
  engines: Record<string, EngineState>
  revision: number
}>(() => ({ engines: {}, revision: 0 }))
const pending = new Map<string, Promise<void>>()
const builtins = new Set([
  "typescript",
  "html",
  "css",
  "vue",
  "prisma",
  "tailwind",
  "slang",
  "prettier",
])
export function engineEnabled(id: string) {
  const feature = extensions.find((e) => e.engine === id)
  return !feature || extensionEnabled(feature.id)
}
export function defaultEngine(language: string): string | undefined {
  if (
    ["typescript", "typescriptreact", "javascript", "javascriptreact"].includes(
      language
    )
  )
    return "typescript"
  if (["css", "scss", "less"].includes(language)) return "css"
  if (["hlsl", "slang"].includes(language)) return "slang"
  if (["vue", "prisma", "html"].includes(language)) return language
}
function publish(id: string, state: EngineState) {
  const old = useEditorEngines.getState().engines[id]
  if (old?.phase === state.phase && old.message === state.message) return
  useEditorEngines.setState((s) => ({
    engines: { ...s.engines, [id]: state },
    revision: s.revision + 1,
  }))
}
function progressMessage(operation: LanguageServerInstallOperation) {
  const downloaded = Number(operation.downloadedBytes)
  const total = Number(operation.totalBytes)
  return downloaded > 0
    ? `${operation.message} · ${(downloaded / 1048576).toFixed(1)}${total > 0 ? ` / ${(total / 1048576).toFixed(1)}` : ""} MB`
    : operation.message
}
/** Native installation events reach every window, including retries initiated elsewhere. */
export function useEditorEngineStatus() {
  useEffect(() => {
    if (!desktopAvailable()) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let revision = 0
    const refresh = async () => {
      const request = ++revision
      try {
        const catalogue = await call<LanguageServerCatalogue>(
          "get_language_server_catalogue"
        )
        if (!active || revision !== request) return
        for (const entry of catalogue.entries) {
          if (!builtins.has(entry.id) || !engineEnabled(entry.id)) continue
          const operation = catalogue.operations.findLast(
            (o) => o.serverId === entry.id
          )
          if (
            operation &&
            ["queued", "installing", "failed", "cancelled"].includes(
              operation.status
            )
          ) {
            publish(entry.id, {
              phase: ["queued", "installing"].includes(operation.status)
                ? "installing"
                : "failed",
              message: progressMessage(operation),
            })
          } else if (
            entry.installedVersion === entry.version &&
            entry.status === "installed"
          ) {
            publish(entry.id, { phase: "ready", message: "Ready" })
          } else if (entry.error) {
            publish(entry.id, { phase: "failed", message: entry.error })
          } else if (
            useEditorEngines.getState().engines[entry.id]?.phase === "ready"
          ) {
            invalidateEngine(entry.id)
          }
        }
        if (
          catalogue.operations.some((o) =>
            ["queued", "installing"].includes(o.status)
          )
        ) {
          clearTimeout(timer)
          timer = setTimeout(() => void refresh(), 500)
        }
      } catch {
        /* Opening settings and editing remain available without a catalogue. */
      }
    }
    const unlisten = listen("reviewbox:language-servers-changed", () => {
      clearTimeout(timer)
      timer = setTimeout(() => void refresh(), 100)
    })
    void unlisten.catch(() => {})
    void refresh()
    return () => {
      active = false
      clearTimeout(timer)
      void unlisten.then((dispose) => dispose()).catch(() => {})
    }
  }, [])
}
/** One installation per engine; a failed attempt needs an explicit retry. */
export function ensureEngine(id: string): Promise<void> {
  if (!desktopAvailable() || !builtins.has(id)) return Promise.resolve()
  if (!engineEnabled(id))
    return Promise.reject(new Error("This extension is disabled."))
  const active = pending.get(id)
  if (active) return active
  const old = useEditorEngines.getState().engines[id]
  if (old?.phase === "ready") return Promise.resolve()
  if (old?.phase === "failed") return Promise.reject(new Error(old.message))
  const work = (async () => {
    publish(id, { phase: "installing", message: "Preparing language support…" })
    const operation = await call<LanguageServerInstallOperation | null>(
      "ensure_editor_engine",
      { serverId: id }
    )
    if (operation) {
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 500))
        const catalogue = await call<LanguageServerCatalogue>(
          "get_language_server_catalogue"
        )
        const current = catalogue.operations.find((o) => o.id === operation.id)
        if (!current)
          throw new Error("Installation interrupted. Retry to continue.")
        if (!engineEnabled(id))
          throw new Error("Installation cancelled: the extension was disabled.")
        if (current.status === "ready") break
        if (!["queued", "installing"].includes(current.status))
          throw new Error(current.message)
        publish(id, { phase: "installing", message: progressMessage(current) })
      }
    }
    publish(id, { phase: "ready", message: "Ready" })
  })()
    .catch((error) => {
      publish(id, { phase: "failed", message: errorMessage(error) })
      throw error
    })
    .finally(() => pending.delete(id))
  pending.set(id, work)
  return work
}
export function retryEngine(id: string) {
  if (pending.has(id)) return pending.get(id)!
  useEditorEngines.setState((s) => {
    const engines = { ...s.engines }
    delete engines[id]
    return { engines }
  })
  return ensureEngine(id)
}
export function invalidateEngine(id: string) {
  useEditorEngines.setState((s) => {
    const engines = { ...s.engines }
    delete engines[id]
    return { engines, revision: s.revision + 1 }
  })
}
