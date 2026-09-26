"use client"

import { EditorContent, useEditor } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import { Placeholder } from "@tiptap/extensions"
import { useEffect, useRef } from "react"

import { cn } from "@/lib/utils"

import type { RichTextEditorProps } from "../contracts/richTextEditor.types"

export function RichTextEditorRuntime({
  initialContent = "",
  onChange,
  onReady,
  editable = true,
  className,
  ariaLabel = "Rich text editor",
  placeholder,
  variant = "field",
  onSubmit,
}: RichTextEditorProps) {
  const submit = useRef(onSubmit)
  useEffect(() => {
    submit.current = onSubmit
  }, [onSubmit])
  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: placeholder ?? "" }),
    ],
    content: initialContent,
    editable,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: cn(
          "text-sm outline-none [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_p+p]:mt-2 [&_ul]:list-disc [&_ul]:pl-5",
          variant === "field" ? "min-h-40 px-3 py-2" : "min-h-0"
        ),
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": ariaLabel,
      },
      handleKeyDown: (_view, event) => {
        if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey))
          return false
        submit.current?.()
        return !!submit.current
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
      className={cn(
        variant === "field" && "rounded-md border border-input bg-background",
        "[&_.is-editor-empty:first-child]:before:pointer-events-none [&_.is-editor-empty:first-child]:before:float-left [&_.is-editor-empty:first-child]:before:h-0 [&_.is-editor-empty:first-child]:before:text-muted-foreground [&_.is-editor-empty:first-child]:before:content-[attr(data-placeholder)]",
        className
      )}
    />
  )
}
