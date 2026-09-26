"use client"
import { useState } from "react"
import type { JSONContent } from "@tiptap/core"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { RichTextEditor } from "@/features/rich-text-editor/components/RichTextEditor"
import { ComposerModeToggle } from "./ComposerModeToggle"

function isEmpty(content: JSONContent | null) {
  return !content?.content?.some((node) => node.content?.length)
}

/** Composer that replaces the decision bar in the Notes tab. */
export function NoteComposer({
  kind,
  disabled,
  onKind,
  onSubmit,
}: {
  kind: "note" | "question"
  disabled: boolean
  onKind: (kind: "note" | "question") => void
  onSubmit: (body: JSONContent, question: boolean) => void
}) {
  const [draft, setDraft] = useState<JSONContent | null>(null)
  const [editorKey, setEditorKey] = useState(0)
  const question = kind === "question"
  const submit = () => {
    if (!draft || isEmpty(draft) || disabled) return
    onSubmit(draft, question)
    setDraft(null)
    setEditorKey((key) => key + 1)
  }
  return (
    <div className="p-3">
      <div className="rounded-3xl border bg-card/60 focus-within:border-ring">
        <RichTextEditor
          key={editorKey}
          variant="plain"
          ariaLabel={question ? "Write a question" : "Write a note"}
          placeholder={
            question
              ? "Ask about this passage…"
              : "Write a note on this passage…"
          }
          onChange={setDraft}
          onSubmit={submit}
          className="max-h-40 overflow-auto px-3 pt-2.5 pb-1 [&_.ProseMirror]:min-h-10"
        />
        <div className="flex items-center gap-2 p-2">
          <ComposerModeToggle value={kind} onChange={onKind} />
          <span className="flex-1" />
          <Kbd>⌘↵</Kbd>
          <Button
            size="sm"
            disabled={disabled || isEmpty(draft)}
            onClick={submit}
          >
            {question ? "Ask question" : "Add note"}
          </Button>
        </div>
      </div>
    </div>
  )
}
