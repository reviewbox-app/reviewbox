"use client"

import { useEffect } from "react"
import { create } from "zustand"
import { listen } from "@tauri-apps/api/event"
import type {
  AppearancePreferences,
  CodeTheme,
  EditorProfile,
} from "@/lib/desktop/contracts.generated"
import {
  call,
  desktopAvailable,
  errorMessage,
} from "@/lib/desktop/review.commands"
import { setCodeTheme } from "@/lib/code/codeAppearance"
import { configureFileIcons } from "@/features/file-icons/stores/useFileIcons.store"

const useAppearanceStore = create<{
  preferences: AppearancePreferences | null
  profiles: EditorProfile[]
  error: string | null
  saving: boolean
}>(() => ({ preferences: null, profiles: [], error: null, saving: false }))

let users = 0
let loading: Promise<void> | undefined
let unsubscribe: Promise<() => void> | undefined

function apply(preferences: AppearancePreferences) {
  const current = useAppearanceStore.getState().preferences
  if (current && current.revision > preferences.revision) return
  useAppearanceStore.setState({ preferences, error: null })
  setCodeTheme(preferences.codeTheme)
  configureFileIcons({
    ...preferences.fileIcons,
    activeIconPack:
      preferences.fileIcons.activeIconPack === "nest" ? "nest" : "default",
  })
}

function retain() {
  users++
  if (desktopAvailable() && !unsubscribe) {
    unsubscribe = listen<AppearancePreferences>(
      "reviewbox:appearance-changed",
      ({ payload }) => apply(payload)
    )
    void unsubscribe.catch((error: unknown) =>
      useAppearanceStore.setState({ error: errorMessage(error) })
    )
  }
  if (desktopAvailable() && !loading) {
    loading = Promise.all([
      call<AppearancePreferences>("appearance_settings"),
      call<EditorProfile[]>("editor_profiles"),
    ])
      .then(([preferences, profiles]) => {
        apply(preferences)
        useAppearanceStore.setState({ profiles })
      })
      .catch((error: unknown) => {
        loading = undefined
        useAppearanceStore.setState({ error: errorMessage(error) })
      })
  }
  return () => {
    if (--users === 0 && unsubscribe) {
      void unsubscribe.then((dispose) => dispose()).catch(() => {})
      unsubscribe = undefined
      loading = undefined
    }
  }
}

async function save(operation: () => Promise<AppearancePreferences>) {
  if (useAppearanceStore.getState().saving) return
  const previous = useAppearanceStore.getState().preferences
  useAppearanceStore.setState({ saving: true, error: null })
  try {
    apply(await operation())
  } catch (error) {
    if (previous) apply(previous)
    useAppearanceStore.setState({ error: errorMessage(error) })
  } finally {
    useAppearanceStore.setState({ saving: false })
  }
}

export function useAppearancePreferences() {
  const state = useAppearanceStore()
  useEffect(retain, [])
  return {
    ...state,
    setCodeTheme: (codeTheme: CodeTheme) => {
      const preferences = useAppearanceStore.getState().preferences
      if (preferences)
        void save(() => {
          apply({ ...preferences, codeTheme })
          return call("configure_appearance", {
            preferences: { ...preferences, codeTheme },
          })
        })
    },
    importIcons: (profileId: string) =>
      save(() => call("import_editor_icons", { profileId })),
  }
}
