"use client"

import { useEffect } from "react"
import { create } from "zustand"
import { listen } from "@tauri-apps/api/event"
import type { AppearancePreferences } from "@/lib/desktop/contracts.generated"
import {
  call,
  desktopAvailable,
  errorMessage,
} from "@/lib/desktop/review.commands"
import { setCodeTheme, setCodeTypography } from "@/lib/code/codeAppearance"

const useAppearanceStore = create<{
  preferences: AppearancePreferences | null
  fonts: string[]
  error: string | null
  saving: boolean
}>(() => ({
  preferences: null,
  fonts: ["Geist Mono"],
  error: null,
  saving: false,
}))
let users = 0
let loading: Promise<void> | undefined
let unsubscribe: Promise<() => void> | undefined
function apply(preferences: AppearancePreferences) {
  const current = useAppearanceStore.getState().preferences
  if (current && current.revision > preferences.revision) return
  useAppearanceStore.setState({ preferences, error: null })
  setCodeTheme(preferences.codeTheme)
  setCodeTypography(
    preferences.codeFontFamily ?? "Geist Mono",
    preferences.codeFontWeight ?? 400
  )
}
function retain() {
  users++
  if (desktopAvailable() && !unsubscribe) {
    unsubscribe = listen<AppearancePreferences>(
      "reviewbox:appearance-changed",
      ({ payload }) => apply(payload)
    )
    void unsubscribe.catch((error) =>
      useAppearanceStore.setState({ error: errorMessage(error) })
    )
  }
  if (desktopAvailable() && !loading) {
    loading = call<AppearancePreferences>("appearance_settings")
      .then(apply)
      .catch((error) => {
        loading = undefined
        useAppearanceStore.setState({ error: errorMessage(error) })
      })
    void call<string[]>("system_code_fonts")
      .then((fonts) => useAppearanceStore.setState({ fonts }))
      .catch((error) =>
        useAppearanceStore.setState({ error: errorMessage(error) })
      )
  }
  return () => {
    if (--users === 0) {
      void unsubscribe?.then((dispose) => dispose()).catch(() => {})
      unsubscribe = undefined
      loading = undefined
    }
  }
}
async function update(patch: Partial<AppearancePreferences>) {
  if (useAppearanceStore.getState().saving) return
  const previous = useAppearanceStore.getState().preferences
  if (!previous) return
  useAppearanceStore.setState({ saving: true })
  apply({ ...previous, ...patch })
  try {
    apply(
      await call<AppearancePreferences>("configure_appearance", {
        preferences: { ...previous, ...patch },
      })
    )
  } catch (error) {
    apply(previous)
    useAppearanceStore.setState({ error: errorMessage(error) })
  } finally {
    useAppearanceStore.setState({ saving: false })
  }
}
export function useAppearancePreferences() {
  const state = useAppearanceStore()
  useEffect(retain, [])
  return { ...state, update }
}
