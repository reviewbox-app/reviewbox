"use client"

import { useEffect } from "react"
import { create } from "zustand"

type Mode = "file" | "content"
const key = "reviewbox.explorer.search-mode"
const useMode = create<{ mode: Mode }>(() => ({ mode: "file" }))
let loaded = false

function setMode(mode: Mode) {
  loaded = true
  useMode.setState({ mode })
  try {
    localStorage.setItem(key, mode)
  } catch {
    /* Session preference still works. */
  }
}

/** Local preference shared by Review and Code Editor, restored only after mounting. */
export function useExplorerSearchMode() {
  const mode = useMode((state) => state.mode)
  useEffect(() => {
    if (loaded) return
    loaded = true
    try {
      const saved = localStorage.getItem(key)
      if (saved === "file" || saved === "content")
        useMode.setState({ mode: saved })
    } catch {
      /* Storage may be unavailable in a restricted webview. */
    }
  }, [])
  return [mode, setMode] as const
}
