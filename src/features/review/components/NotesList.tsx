import type { JSONContent } from "@tiptap/core"
import { HugeiconsIcon } from "@hugeicons/react"
import { Delete02Icon, InformationCircleIcon } from "@hugeicons/core-free-icons"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { RichTextEditor } from "@/features/rich-text-editor/components/RichTextEditor"
import type { Annotation } from "@/lib/desktop/contracts.generated"
import { cn } from "@/lib/utils"
import { CommentHeader } from "./CommentHeader"
import { ReviewStatus } from "./ReviewStatus"
import { authorOf, shortTime } from "../helpers/review.helpers"

function noteContent(body: string): JSONContent {
  try {
    return JSON.parse(body) as JSONContent
  } catch {
    return {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: body }] }],
    }
  }
}

function Section({
  title,
  count,
  children,
}: {
  title: string
  count: number
  children: React.ReactNode
}) {
  if (!count) return null
  return (
    <section className="space-y-2">
      <h3 className="text-xs text-muted-foreground">
        {title} · {count}
      </h3>
      {children}
    </section>
  )
}

/** Notes tab: open questions, resolved questions (with their context), notes. */
export function NotesList({
  notes,
  busy,
  onResolve,
  onDelete,
}: {
  notes: Annotation[]
  busy: boolean
  onResolve: (note: Annotation) => void
  onDelete: (note: Annotation) => void
}) {
  const open = notes.filter((n) => n.question && !n.resolved)
  const resolved = notes.filter((n) => n.question && n.resolved)
  const plain = notes.filter((n) => !n.question)
  const question = (note: Annotation) => (
    <article
      key={note.id}
      className={cn(
        "group/note flex gap-2.5 rounded-2xl p-3",
        note.resolved ? "px-1" : "bg-secondary"
      )}
    >
      <ReviewStatus
        status={note.resolved ? "Validated" : "Question"}
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1">
        <RichTextEditor
          editable={false}
          variant="plain"
          initialContent={noteContent(note.body)}
          className="text-sm"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          {note.resolved
            ? `Resolved${note.resolvedAt ? ` · ${shortTime(note.resolvedAt)}` : ""} · asked by ${authorOf(note.author).name}`
            : `Asked by ${authorOf(note.author).name} · ${shortTime(note.createdAt)} · waiting for your decision`}
        </p>
        <div className="mt-2 flex gap-1">
          <Button
            size="xs"
            variant={note.resolved ? "ghost" : "secondary"}
            disabled={busy}
            onClick={() => onResolve(note)}
          >
            {note.resolved ? "Reopen" : "Resolve"}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            className="text-muted-foreground"
            disabled={busy}
            onClick={() => onDelete(note)}
          >
            Delete
          </Button>
        </div>
      </div>
    </article>
  )
  return (
    <div className="space-y-5">
      {notes.length === 0 && (
        <Alert size="sm" variant="faded">
          <HugeiconsIcon icon={InformationCircleIcon} aria-hidden />
          <AlertTitle>No notes on this passage yet.</AlertTitle>
          <AlertDescription>
            Write one below, or switch to Question when you need an answer
            before validating.
          </AlertDescription>
        </Alert>
      )}
      <Section title="Open" count={open.length}>
        {open.map(question)}
      </Section>
      <Section title="Resolved" count={resolved.length}>
        {resolved.map(question)}
      </Section>
      <Section title="Notes" count={plain.length}>
        {plain.map((note) => (
          <article
            key={note.id}
            className="group/note relative space-y-1 rounded-2xl border p-3"
          >
            <CommentHeader author={note.author} createdAt={note.createdAt} />
            <RichTextEditor
              editable={false}
              variant="plain"
              initialContent={noteContent(note.body)}
              className="pl-8 text-sm"
            />
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Delete note"
              disabled={busy}
              className="absolute top-2.5 right-2.5 opacity-0 group-focus-within/note:opacity-100 group-hover/note:opacity-100"
              onClick={() => onDelete(note)}
            >
              <HugeiconsIcon icon={Delete02Icon} size={14} />
            </Button>
          </article>
        ))}
      </Section>
    </div>
  )
}
