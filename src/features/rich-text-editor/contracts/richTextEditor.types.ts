import type { Editor, JSONContent } from "@tiptap/core"

export interface RichTextEditorProps {
  /** Used at creation. Change the component key to load a different document. */
  initialContent?: JSONContent | string
  onChange?: (content: JSONContent) => void
  onReady?: (editor: Editor) => void
  editable?: boolean
  className?: string
  ariaLabel?: string
}
