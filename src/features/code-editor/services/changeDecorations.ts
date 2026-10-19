import { diffLines } from "diff"
import type { editor } from "monaco-editor"

/** Line decorations, not text edits. A bounded diff never stalls large files. */
export function changeDecorations(
  before: string,
  after: string
): editor.IModelDeltaDecoration[] {
  if (before.length + after.length > 4_000_000) return []
  const parts = diffLines(
    before.replace(/\r\n/g, "\n"),
    after.replace(/\r\n/g, "\n"),
    { timeout: 40, maxEditLength: 20_000 }
  )
  if (!parts) return []
  const result: editor.IModelDeltaDecoration[] = []
  let line = 1
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (!part.added && !part.removed) {
      line += part.count
      continue
    }
    const added =
      part.removed && parts[i + 1]?.added
        ? parts[++i]
        : part.added
          ? part
          : undefined
    const kind = part.removed ? (added ? "modified" : "deleted") : "added"
    const start = added ? line : Math.max(1, line - 1)
    result.push({
      range: {
        startLineNumber: start,
        startColumn: 1,
        endLineNumber: added ? start + added.count - 1 : start,
        endColumn: 1,
      },
      options: {
        isWholeLine: !!added,
        linesDecorationsClassName: `reviewbox-change-${kind}`,
        linesDecorationsTooltip:
          kind === "added"
            ? "Added lines"
            : kind === "deleted"
              ? "Removed lines"
              : "Modified lines",
      },
    })
    if (added) line += added.count
  }
  return result
}

export function bindChangeDecorations(
  instance: editor.IStandaloneCodeEditor,
  baseline: () => string | undefined
) {
  const decorations = instance.createDecorationsCollection()
  let timer: ReturnType<typeof setTimeout> | undefined
  const refresh = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      const model = instance.getModel()
      const before = baseline()
      decorations.set(
        model && before !== undefined
          ? changeDecorations(before, model.getValue())
          : []
      )
    }, 120)
  }
  const content = instance.onDidChangeModelContent(refresh)
  refresh()
  return {
    refresh,
    dispose: () => {
      clearTimeout(timer)
      content.dispose()
      decorations.clear()
    },
  }
}
