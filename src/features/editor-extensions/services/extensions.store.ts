"use client"
import { configureShaderSyntax } from "@/lib/code/highlighter"
import { useEffect } from "react"
import { create } from "zustand"
import { listen } from "@tauri-apps/api/event"
import {
  call,
  desktopAvailable,
  errorMessage,
} from "@/lib/desktop/review.commands"
import type {
  EditorExtensionId,
  EditorExtensionPreferences,
} from "@/lib/desktop/contracts.generated"
import {
  setBracketColorization,
  setEditorExtensionOptions,
} from "@/lib/code/codeAppearance"

export const extensions: {
  id: EditorExtensionId
  name: string
  description: string
  engine?: string
}[] = [
  {
    id: "autoRenameTag",
    name: "Auto Rename Tag",
    description: "Keep opening and closing tags in sync.",
  },
  {
    id: "autoImport",
    name: "Auto Import",
    description: "Suggest symbols and insert their imports.",
  },
  {
    id: "npmIntellisense",
    name: "npm IntelliSense",
    description: "Complete package names in imports.",
  },
  {
    id: "pathIntellisense",
    name: "Path IntelliSense",
    description: "Complete file paths and project aliases.",
  },
  {
    id: "colorHighlight",
    name: "Color Highlight",
    description: "Preview color values directly in your code.",
  },
  {
    id: "prettier",
    name: "Prettier",
    description: "Format code using your project's configuration and plugins.",
    engine: "prettier",
  },
  {
    id: "prisma",
    name: "Prisma",
    description: "Suggestions, diagnostics and navigation for Prisma schemas.",
    engine: "prisma",
  },
  {
    id: "shaders",
    name: "Shaders",
    description: "GLSL, HLSL and Cg colors, with HLSL language assistance.",
    engine: "slang",
  },
  {
    id: "tailwind",
    name: "Tailwind CSS",
    description: "Class suggestions, documentation, diagnostics and colors.",
    engine: "tailwind",
  },
  {
    id: "vue",
    name: "Vue",
    description: "Components, templates and TypeScript language assistance.",
    engine: "vue",
  },
  {
    id: "bracketColorization",
    name: "Bracket Pair Colorization",
    description: "Distinguish nested brackets by color.",
  },
]
const defaults = Object.fromEntries(
  extensions.map((e) => [e.id, true])
) as EditorExtensionPreferences["enabled"]
export const useExtensionsStore = create<{
  preferences: EditorExtensionPreferences
  loaded: boolean
  error: string
  busy: EditorExtensionId | null
}>(() => ({
  preferences: { revision: 0, enabled: defaults, prettierOnSave: true },
  loaded: false,
  error: "",
  busy: null,
}))
export const extensionEnabled = (id: EditorExtensionId) =>
  useExtensionsStore.getState().preferences.enabled[id] !== false
function apply(preferences: EditorExtensionPreferences) {
  const previous = useExtensionsStore.getState()
  if (previous.loaded && previous.preferences.revision > preferences.revision)
    return
  useExtensionsStore.setState({
    preferences: {
      ...preferences,
      enabled: { ...defaults, ...preferences.enabled },
    },
    loaded: true,
    error: "",
  })
  configureShaderSyntax(preferences.enabled.shaders !== false)
  setBracketColorization(preferences.enabled.bracketColorization !== false)
  setEditorExtensionOptions(
    preferences.enabled.autoRenameTag !== false,
    preferences.enabled.colorHighlight !== false
  )
}
let users = 0
let unlisten: Promise<() => void> | undefined
let loading: Promise<void> | undefined
export function loadExtensions() {
  if (!desktopAvailable()) return Promise.resolve()
  loading ??= call<EditorExtensionPreferences>("editor_extension_settings")
    .then(apply)
    .catch((error) => {
      loading = undefined
      useExtensionsStore.setState({ error: errorMessage(error) })
      throw error
    })
  return loading
}
export function useEditorExtensions() {
  const state = useExtensionsStore()
  useEffect(() => {
    users++
    if (desktopAvailable() && !unlisten)
      unlisten = listen<EditorExtensionPreferences>(
        "reviewbox:extensions-changed",
        ({ payload }) => apply(payload)
      )
    void loadExtensions().catch(() => {})
    void unlisten?.catch(() => {})
    return () => {
      if (--users === 0) {
        void unlisten?.then((dispose) => dispose()).catch(() => {})
        unlisten = undefined
        loading = undefined
      }
    }
  }, [])
  return {
    ...state,
    setPrettierOnSave: async (enabled: boolean) => {
      try {
        apply(
          await call<EditorExtensionPreferences>("set_prettier_on_save", {
            enabled,
          })
        )
      } catch (error) {
        useExtensionsStore.setState({ error: errorMessage(error) })
      }
    },
    setEnabled: async (id: EditorExtensionId, enabled: boolean) => {
      if (useExtensionsStore.getState().busy) return
      useExtensionsStore.setState({ busy: id, error: "" })
      try {
        apply(
          await call<EditorExtensionPreferences>("set_editor_extension", {
            id,
            enabled,
          })
        )
      } catch (error) {
        useExtensionsStore.setState({ error: errorMessage(error) })
      } finally {
        useExtensionsStore.setState({ busy: null })
      }
    },
  }
}
