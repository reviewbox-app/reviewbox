import chroma from "chroma-js"
import type * as M from "monaco-editor/editor/editor.api"
import { extensionEnabled, useExtensionsStore } from "./extensions.store"

export function literalColors(text: string) {
  const colors: { start: number; end: number; rgba: number[] }[] = []
  const expression =
    /#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})\b|\b(?:rgba?|hsla?|oklch|oklab|lch|lab)\([^()\n]{1,160}\)/gi
  for (const match of text.matchAll(expression)) {
    try {
      colors.push({
        start: match.index,
        end: match.index + match[0].length,
        rgba: chroma(match[0]).rgba(),
      })
    } catch {
      /* An unfinished literal stays editable. */
    }
    if (colors.length >= 500) break
  }
  return colors
}
export function modelColors(
  model: M.editor.ITextModel
): M.languages.IColorInformation[] {
  return literalColors(model.getValue()).map((c) => {
    const start = model.getPositionAt(c.start),
      end = model.getPositionAt(c.end)
    return {
      range: {
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: end.column,
      },
      color: {
        red: c.rgba[0] / 255,
        green: c.rgba[1] / 255,
        blue: c.rgba[2] / 255,
        alpha: c.rgba[3],
      },
    }
  })
}
let nextId = 0
export function decorateColors(
  monaco: typeof M,
  model: M.editor.ITextModel,
  computed: () => Promise<M.languages.IColorInformation[]>
) {
  const prefix = `rb-color-${++nextId}`
  const style = document.createElement("style")
  document.head.append(style)
  let decorations: string[] = []
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  async function refresh() {
    const sequence = ++generation,
      version = model.getVersionId()
    if (model.isDisposed()) return
    decorations = model.deltaDecorations(decorations, [])
    style.textContent = ""
    if (!extensionEnabled("colorHighlight")) return
    const colors = [
      ...modelColors(model),
      ...(await computed().catch(() => [])),
    ]
    if (
      sequence !== generation ||
      model.isDisposed() ||
      model.getVersionId() !== version ||
      !extensionEnabled("colorHighlight")
    )
      return
    const seen = new Set<string>(),
      rules: string[] = []
    decorations = model.deltaDecorations(
      decorations,
      colors
        .filter((c) => {
          const key = JSON.stringify(c.range)
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
        .slice(0, 500)
        .map((c, i) => {
          const cls = `${prefix}-${i}`
          const rgb = [c.color.red, c.color.green, c.color.blue]
            .map((v) => Math.round(v * 255))
            .join(",")
          rules.push(
            `.${cls}{background-color:rgba(${rgb},${Math.min(0.28, c.color.alpha * 0.28)});border-bottom:2px solid rgba(${rgb},${c.color.alpha});border-radius:2px}`
          )
          return {
            range: c.range,
            options: {
              inlineClassName: cls,
              stickiness:
                monaco.editor.TrackedRangeStickiness
                  .NeverGrowsWhenTypingAtEdges,
            },
          }
        })
    )
    style.textContent = rules.join("\n")
  }
  function schedule() {
    ++generation
    clearTimeout(timer)
    timer = setTimeout(() => void refresh(), 180)
  }
  const content = model.onDidChangeContent(schedule)
  const unlisten = useExtensionsStore.subscribe(() => {
    void refresh()
  })
  schedule()
  return {
    refresh: schedule,
    dispose() {
      ++generation
      clearTimeout(timer)
      content.dispose()
      unlisten()
      if (!model.isDisposed()) model.deltaDecorations(decorations, [])
      style.remove()
    },
  }
}
