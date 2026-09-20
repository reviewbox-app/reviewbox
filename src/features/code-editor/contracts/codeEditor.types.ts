import type { DiffEditorProps, EditorProps } from "@monaco-editor/react"
import type * as Monaco from "monaco-editor"
import type { editor } from "monaco-editor"

// The React wrapper still references a legacy Monaco type path removed in 0.56.
type MonacoInstance = typeof Monaco

export type CodeEditorProps = Omit<EditorProps, "beforeMount" | "onMount"> & {
  beforeMount?: (monaco: MonacoInstance) => void
  onMount?: (
    editor: editor.IStandaloneCodeEditor,
    monaco: MonacoInstance
  ) => void
}

export type CodeDiffEditorProps = Omit<
  DiffEditorProps,
  "beforeMount" | "onMount"
> & {
  beforeMount?: (monaco: MonacoInstance) => void
  onMount?: (
    editor: editor.IStandaloneDiffEditor,
    monaco: MonacoInstance
  ) => void
}
