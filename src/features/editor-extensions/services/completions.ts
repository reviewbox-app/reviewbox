import type * as M from "monaco-editor/editor/editor.api"
import type * as L from "vscode-languageserver-protocol"
import type { EditorPathSuggestion } from "@/lib/desktop/contracts.generated"
import { call } from "@/lib/desktop/review.commands"
import { extensionEnabled } from "./extensions.store"

export function specifierContext(source: string) {
  const match =
    /(?:\b(?:import|export)\s+(?:[^;\n]*?\s+from\s*)?|\b(?:require|import)\s*\(\s*|\b(?:src|href|poster)\s*=\s*|\burl\(\s*|@import\s*)["']([^"'\n]*)$/.exec(
      source
    )
  if (!match) return
  const prefix = match[1]
  const resource = /^(?:src|href|poster|url|@import)/.test(match[0])
  return { prefix, packages: !resource && !/^[./~]/.test(prefix) }
}
export function allowCompletion(
  item: L.CompletionItem,
  context: ReturnType<typeof specifierContext>
) {
  if (context)
    return extensionEnabled(
      context.packages && ![17, 19].includes(item.kind ?? 0)
        ? "npmIntellisense"
        : "pathIntellisense"
    )
  if (extensionEnabled("autoImport")) return true
  const data = item.data as
    { source?: string; entryNames?: { source?: string }[] } | undefined
  return (
    !item.sortText?.startsWith("\uffff") &&
    !item.additionalTextEdits?.length &&
    !data?.source &&
    !data?.entryNames?.some((e) => e.source) &&
    !/\bauto.?import\b/i.test(item.detail ?? "")
  )
}
export async function pathSuggestions(
  monaco: typeof M,
  model: M.editor.ITextModel,
  p: M.Position,
  repositoryId: string,
  path: string,
  existing: string[] = []
) {
  const context = specifierContext(
    model
      .getValue()
      .slice(Math.max(0, model.getOffsetAt(p) - 1000), model.getOffsetAt(p))
  )
  if (
    !context ||
    !extensionEnabled(context.packages ? "npmIntellisense" : "pathIntellisense")
  )
    return []
  const result = await call<EditorPathSuggestion[]>("complete_editor_paths", {
    repositoryId,
    path,
    ...context,
  })
  const partial = context.packages
    ? context.prefix
    : context.prefix.slice(context.prefix.lastIndexOf("/") + 1)
  const normalize = (label: string) =>
    label.replace(/\/$/, "").replace(/\.[cm]?[jt]sx?$/, "")
  const known = new Set(existing.map(normalize))
  return result
    .filter((s) => !known.has(normalize(s.label)))
    .map((s) => ({
      label: s.label,
      insertText: s.label,
      kind: s.package
        ? monaco.languages.CompletionItemKind.Module
        : s.directory
          ? monaco.languages.CompletionItemKind.Folder
          : monaco.languages.CompletionItemKind.File,
      range: {
        startLineNumber: p.lineNumber,
        endLineNumber: p.lineNumber,
        startColumn: p.column - partial.length,
        endColumn: p.column,
      },
      sortText: `z-${s.label}`,
    }))
}
