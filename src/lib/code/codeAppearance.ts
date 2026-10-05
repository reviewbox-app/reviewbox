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

let codeFont = "Geist Mono"
let codeWeight = 400
let brackets = true
let linkedEditing = true
let colorDecorators = true
let monacoRuntime: typeof import("monaco-editor/editor/editor.api") | undefined
export function codeEditorOptions() {
  const bundled =
    typeof document === "undefined"
      ? "monospace"
      : getComputedStyle(document.documentElement)
          .getPropertyValue("--font-geist-mono")
          .trim() || "monospace"
  return {
    fontFamily: `${JSON.stringify(codeFont)}, ${bundled}, monospace`,
    fontWeight: String(codeWeight),
    bracketPairColorization: { enabled: brackets },
    fontLigatures: false,
    linkedEditing,
    colorDecorators,
  }
}
function refreshEditors() {
  const options = codeEditorOptions()
  for (const editor of monacoRuntime?.editor.getDiffEditors() ?? []) {
    const modified = editor.getModifiedEditor()
    const before = modified.getOption(
      monacoRuntime!.editor.EditorOption.fontInfo
    )
    editor.updateOptions(options)
    const after = modified.getOption(
      monacoRuntime!.editor.EditorOption.fontInfo
    )
    if (
      modified.getModel() &&
      (before.fontFamily !== after.fontFamily ||
        before.fontWeight !== after.fontWeight)
    ) {
      // Monaco 0.56 rebuilds deleted-line zones on wrap/line-height changes, but
      // not on font changes alone. An empty layout change refreshes those zones
      // without replacing models or disturbing selection, scroll and undo.
      modified.changeViewZones((zones) => {
        const id = zones.addZone({
          afterLineNumber: 0,
          heightInPx: 0,
          domNode: modified.getDomNode()!.ownerDocument.createElement("div"),
        })
        zones.removeZone(id)
      })
    }
  }
  for (const editor of monacoRuntime?.editor.getEditors() ?? [])
    editor.updateOptions(options)
  for (const model of monacoRuntime?.editor.getModels() ?? [])
    model.updateOptions({
      bracketColorizationOptions: {
        enabled: brackets,
        independentColorPoolPerBracketType: false,
      },
    })
  monacoRuntime?.editor.remeasureFonts()
}
export function setCodeTypography(family: string, weight: number) {
  codeFont = family
  codeWeight = weight
  if (typeof document !== "undefined") {
    document.documentElement.style.setProperty(
      "--font-code",
      `${JSON.stringify(family)}, var(--font-geist-mono), monospace`
    )
    document.documentElement.style.setProperty(
      "--code-font-weight",
      String(weight)
    )
    void document.fonts.ready.then(refreshEditors)
  }
  refreshEditors()
}
export function setBracketColorization(enabled: boolean) {
  brackets = enabled
  refreshEditors()
}
/** One application lifetime owner; editors themselves retain their buffers and undo. */
export function observeCodeEditors(
  monaco: typeof import("monaco-editor/editor/editor.api")
) {
  if (monacoRuntime) return
  monacoRuntime = monaco
  monaco.editor.onDidCreateEditor((editor) =>
    editor.updateOptions(codeEditorOptions())
  )
  monaco.editor.onDidCreateDiffEditor((editor) =>
    editor.updateOptions(codeEditorOptions())
  )
  const applyBrackets = (
    model: import("monaco-editor/editor/editor.api").editor.ITextModel
  ) =>
    model.updateOptions({
      bracketColorizationOptions: {
        enabled: brackets,
        independentColorPoolPerBracketType: false,
      },
    })
  monaco.editor.onDidCreateModel(applyBrackets)
  monaco.editor.onDidChangeModelLanguage(({ model }) => applyBrackets(model))
  refreshEditors()
}

export function setEditorExtensionOptions(tags: boolean, colors: boolean) {
  linkedEditing = tags
  colorDecorators = colors
  refreshEditors()
  refreshLinkedEditing()
}

/** Monaco 0.56 keeps its last position after a provider/option is removed. Even
 * its public linked-editing action then returns early at that same position.
 * Invalidate only this request cache; models, selections and undo stay intact. */
export function refreshLinkedEditing(
  model?: import("monaco-editor/editor/editor.api").editor.ITextModel
) {
  if (!linkedEditing || !monacoRuntime) return
  for (const editor of monacoRuntime.editor.getEditors()) {
    if (model && editor.getModel() !== model) continue
    const contribution = editor.getContribution(
      "editor.contrib.linkedEditing"
    ) as
      | (import("monaco-editor/editor/editor.api").editor.IEditorContribution & {
          _currentRequestPosition?: unknown
          updateRanges?: () => Promise<void>
        })
      | null
    if (
      contribution &&
      "_currentRequestPosition" in contribution &&
      typeof contribution.updateRanges === "function"
    ) {
      contribution._currentRequestPosition = null
      void contribution.updateRanges().catch(() => {})
    }
  }
}
