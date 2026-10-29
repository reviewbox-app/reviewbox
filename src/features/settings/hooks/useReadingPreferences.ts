"use client"
import { useSyncExternalStore } from "react"
import type { ReadingLevel } from "@/lib/desktop/contracts.generated"

const key = "reviewbox.reading-preferences"
const event = "reviewbox:reading-preferences"
const defaults = { level: "essential" as ReadingLevel, askEachReview: false }
let raw: string | null | undefined
let cached = defaults
export function getReadingPreferences() {
  if (typeof window === "undefined") return defaults
  let next: string | null = null
  try {
    next = localStorage.getItem(key)
  } catch {
    return cached
  }
  if (next !== raw) {
    raw = next
    try {
      const value = JSON.parse(next ?? "null")
      // Normalize preferences written before the reading modes were renamed.
      const level =
        value?.level === "beginner"
          ? "essential"
          : value?.level === "intermediate"
            ? "explained"
            : value?.level === "developer"
              ? "technical"
              : value?.level
      cached =
        value && ["essential", "explained", "technical"].includes(level)
          ? {
              level: level as ReadingLevel,
              askEachReview: value.askEachReview === true,
            }
          : defaults
    } catch {
      cached = defaults
    }
  }
  return cached
}
function subscribe(listener: () => void) {
  window.addEventListener("storage", listener)
  window.addEventListener(event, listener)
  return () => {
    window.removeEventListener("storage", listener)
    window.removeEventListener(event, listener)
  }
}
function update(patch: Partial<typeof defaults>) {
  cached = { ...getReadingPreferences(), ...patch }
  raw = JSON.stringify(cached)
  try {
    localStorage.setItem(key, raw)
  } catch {
    /* Preference remains available for this session. */
  }
  window.dispatchEvent(new Event(event))
}
export function useReadingPreferences() {
  const value = useSyncExternalStore(
    subscribe,
    getReadingPreferences,
    () => defaults
  )
  return {
    ...value,
    setLevel: (level: ReadingLevel) => update({ level }),
    setAskEachReview: (askEachReview: boolean) => update({ askEachReview }),
  }
}
