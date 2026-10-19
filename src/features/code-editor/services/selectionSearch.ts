import type * as Monaco from "monaco-editor/editor/editor.api"

/** Register on each visible editor, including virtual diff cells. */
export function bindSelectionSearch(
  monaco: typeof Monaco,
  editor: Monaco.editor.IStandaloneCodeEditor,
  search?: (text: string) => void
) {
  const selectedText = () => {
    const selection = editor.getSelection()
    return (selection && editor.getModel()?.getValueInRange(selection)) || ""
  }
  const action = editor.addAction({
    id: "reviewbox.search-selection",
    label: "Search selection",
    precondition: "editorHasSelection",
    keybindings: [
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF,
    ],
    contextMenuGroupId: "navigation",
    contextMenuOrder: 3,
    run: () => {
      const text = selectedText()
      if (!text) return
      if (search) search(text)
      else void editor.getAction("actions.find")?.run()
    },
  })
  return {
    dispose() {
      action.dispose()
    },
  }
}
