import type { editor } from "monaco-editor"

/** Center within the visible area between floating bars, respecting wrapped lines. */
export function revealPassage(
  instance: editor.IStandaloneCodeEditor,
  start: number,
  end: number,
  overlay: { top: number; bottom: number } = { top: 0, bottom: 0 }
) {
  const height = instance.getLayoutInfo().height
  const available = Math.max(1, height - overlay.top - overlay.bottom)
  const top = instance.getTopForLineNumber(start)
  const bottom = instance.getBottomForLineNumber(end)
  const center = bottom - top > available ? top : (top + bottom) / 2
  instance.setScrollTop(Math.max(0, center - overlay.top - available / 2))
}
