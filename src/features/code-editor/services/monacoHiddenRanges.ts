import type { editor, IRange } from "monaco-editor"

/**
 * Monaco 0.56's code editor exposes the same hidden-area primitive used by its
 * diff and folding controllers, but omits it from the public declaration.
 * Keep this version-sensitive bridge isolated and exercise it in native tests.
 * It hides view lines only; the complete source model remains untouched.
 */
export function hideRanges(
  instance: editor.IStandaloneCodeEditor,
  ranges: IRange[]
) {
  const supported = instance as editor.IStandaloneCodeEditor & {
    setHiddenAreas?: (ranges: IRange[], source?: unknown) => void
  }
  if (!supported.setHiddenAreas)
    throw new Error("This Monaco version cannot render block comparisons.")
  supported.setHiddenAreas(ranges, "reviewbox-block-diff")
}

export function lineRange(start: number, end: number): IRange {
  return {
    startLineNumber: start,
    startColumn: 1,
    endLineNumber: end,
    endColumn: 1,
  }
}
