"use client"

import { useSyncExternalStore } from "react"

export type CodeTheme = "tokyo-night" | "reviewbox"

let selected: CodeTheme = "tokyo-night"
const listeners = new Set<() => void>()

/** Personal preferences own persistence; the editor only observes this value. */
export function setCodeTheme(theme: CodeTheme) {
  if (selected === theme) return
  selected = theme
  for (const listener of listeners) listener()
}

export function getCodeTheme() {
  return selected
}

export function codeThemeName(theme: CodeTheme, dark = true) {
  return `${theme}-${dark ? "dark" : "light"}`
}

export function useCodeTheme(dark = true) {
  const theme = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getCodeTheme,
    () => "tokyo-night" as const
  )
  return codeThemeName(theme, dark)
}
