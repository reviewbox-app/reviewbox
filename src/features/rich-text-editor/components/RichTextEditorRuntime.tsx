"use client"

import { EditorContent, useEditor } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import { useEffect } from "react"

import { cn } from "@/lib/utils"

import type { RichTextEditorProps } from "../contracts/richTextEditor.types"

export function RichTextEditorRuntime({
  initialContent = "",
  onChange,
  onReady,
  editable = true,
  className,
  ariaLabel = "Rich text editor",
}: RichTextEditorProps) {
  const editor = useEditor({
    extensions: [StarterKit],
    content: initialContent,
    editable,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class:
          "min-h-40 px-3 py-2 text-sm outline-none [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_p+p]:mt-2 [&_ul]:list-disc [&_ul]:pl-5",
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": ariaLabel,
      },
    },
    onCreate: ({ editor: createdEditor }) => onReady?.(createdEditor),
    onUpdate: ({ editor: updatedEditor }) =>
      onChange?.(updatedEditor.getJSON()),
  })

  useEffect(() => {
    if (editor && editor.isEditable !== editable) {
      editor.setEditable(editable, false)
    }
  }, [editor, editable])

  return (
    <EditorContent
      editor={editor}
      className={cn("rounded-md border border-input bg-background", className)}
    />
  )
}
