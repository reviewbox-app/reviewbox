import type { DiffEditorProps, EditorProps } from "@monaco-editor/react"
import type * as Monaco from "monaco-editor/editor/editor.api"
import type { editor } from "monaco-editor"
import type { LanguageDocument } from "@/lib/desktop/contracts.generated"

// The React wrapper still references a legacy Monaco type path removed in 0.56.
type MonacoInstance = typeof Monaco

export type CodeEditorProps = Omit<EditorProps, "beforeMount" | "onMount"> & {
  languageDocument?: LanguageDocument
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
  originalLanguageDocument?: LanguageDocument
  modifiedLanguageDocument?: LanguageDocument
  beforeMount?: (monaco: MonacoInstance) => void
  onMount?: (
    editor: editor.IStandaloneDiffEditor,
    monaco: MonacoInstance
  ) => void
}
