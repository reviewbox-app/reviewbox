import type * as M from "monaco-editor/editor/editor.api"
import { call } from "@/lib/desktop/review.commands"
import { extensionEnabled } from "./extensions.store"
import { ensureEngine } from "./engines"

const languages = new Set([
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "jsonc",
  "json5",
  "css",
  "scss",
  "less",
  "html",
  "vue",
  "svelte",
  "astro",
  "markdown",
  "mdx",
  "yaml",
  "graphql",
  "angular-html",
])
export const prettierSupports = (language: string) => languages.has(language)
export function prettierEnabled(language: string) {
  return extensionEnabled("prettier") && prettierSupports(language)
}
export async function formatText(
  repositoryId: string,
  path: string,
  text: string,
  selection?: { start: number; end: number }
) {
  await ensureEngine("prettier")
  if (!extensionEnabled("prettier")) throw new Error("Prettier was disabled.")
  return call<string | null>("format_editor_document", {
    repositoryId,
    path,
    text,
    rangeStart: selection?.start ?? null,
    rangeEnd: selection?.end ?? null,
  })
}
export async function formatModel(
  model: M.editor.ITextModel,
  repository: string,
  path: string,
  token: M.CancellationToken,
  selection?: M.IRange
) {
  const version = model.getVersionId()
  const text = await formatText(
    repository,
    path,
    model.getValue(),
    selection
      ? {
          start: model.getOffsetAt({
            lineNumber: selection.startLineNumber,
            column: selection.startColumn,
          }),
          end: model.getOffsetAt({
            lineNumber: selection.endLineNumber,
            column: selection.endColumn,
          }),
        }
      : undefined
  )
  if (
    text == null ||
    model.isDisposed() ||
    model.getVersionId() !== version ||
    token.isCancellationRequested ||
    !extensionEnabled("prettier")
  )
    return []
  return [{ range: model.getFullModelRange(), text }]
}
