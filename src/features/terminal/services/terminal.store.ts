import { create } from "zustand"
import type { TerminalSession } from "@/lib/desktop/contracts.generated"

export type TerminalTab = TerminalSession & { title: string }
export const useTerminalStore = create<{
  tabs: TerminalTab[]
  active: Record<string, string>
  error: string
  creating: boolean
}>(() => ({ tabs: [], active: {}, error: "", creating: false }))
export function selectTerminal(repositoryId: string, id: string) {
  useTerminalStore.setState((s) => ({
    active: { ...s.active, [repositoryId]: id },
  }))
}
export function renameTerminal(id: string, title: string) {
  useTerminalStore.setState((s) => ({
    tabs: s.tabs.map((t) =>
      t.id === id ? { ...t, title: title.trim() || t.title } : t
    ),
  }))
}
export function reorderTerminals(active: string, over: string) {
  useTerminalStore.setState((s) => {
    const tabs = [...s.tabs]
    const from = tabs.findIndex((tab) => tab.id === active)
    const to = tabs.findIndex((tab) => tab.id === over)
    if (from < 0 || to < 0 || tabs[from].repositoryId !== tabs[to].repositoryId)
      return s
    tabs.splice(to, 0, tabs.splice(from, 1)[0])
    return { tabs }
  })
}
