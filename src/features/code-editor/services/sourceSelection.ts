import type { editor } from "monaco-editor"
import type { SourceSelection } from "../contracts/sourceSelection.types"

/** Selection stays in its original model even inside a virtualized diff cell. */
export function observeSourceSelection(
  source: editor.IStandaloneCodeEditor,
  side: SourceSelection["side"],
  receive: (selection: SourceSelection | null) => void
) {
  const update = () => {
    if (!source.hasTextFocus()) return
    const selection = source.getSelection()
    const model = source.getModel()
    const host = source.getDomNode()
    if (!selection || selection.isEmpty() || !model || !host) {
      receive(null)
      return
    }
    const position = source.getScrolledVisiblePosition({
      lineNumber: selection.startLineNumber,
      column: selection.startColumn,
    })
    const rect = host.getBoundingClientRect()
    if (!position || position.top < 0 || position.top > rect.height) {
      receive(null)
      return
    }
    receive({
      side,
      range: {
        startLine: selection.startLineNumber,
        startColumn: selection.startColumn,
        endLine: selection.endLineNumber,
        endColumn: selection.endColumn,
      },
      excerpt: model.getValueInRange(selection),
      position: {
        left: rect.left + position.left,
        top: rect.top + position.top,
        bottom: rect.top + position.top + position.height,
      },
    })
  }
  const listeners = [
    source.onDidChangeCursorSelection(update),
    source.onDidScrollChange(update),
    source.onDidLayoutChange(update),
    source.onDidFocusEditorText(update),
  ]
  return { dispose: () => listeners.forEach((listener) => listener.dispose()) }
}
