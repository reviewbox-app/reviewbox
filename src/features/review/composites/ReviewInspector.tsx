"use client"
import { EvidencePanel } from "@/features/evidence/composites/EvidencePanel"
import { AgentConversation } from "@/features/agents/composites/AgentConversation"
import { useState } from "react"
import type { JSONContent } from "@tiptap/core"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { RichTextEditor } from "@/features/rich-text-editor/components/RichTextEditor"
import type {
  CodeAnchor,
  ReviewAction,
  Workspace,
} from "@/lib/desktop/contracts.generated"
import { ReviewStatus } from "../components/ReviewStatus"
import { passageStatus } from "../helpers/review.helpers"
import { useReviewWorkspaceStore } from "../stores/useReviewWorkspace.store"

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
export function ReviewInspector({
  workspace,
  anchor,
  busy,
  onAction,
  onNext,
  onApplied,
}: {
  workspace: Workspace
  anchor: CodeAnchor | null
  busy: boolean
  onAction: (action: ReviewAction) => void
  onNext: (direction: number) => void
  onApplied: () => void
}) {
  const { inspector, setInspector, noteKind, setNoteKind } =
    useReviewWorkspaceStore()
  const [draft, setDraft] = useState<JSONContent | null>(null)
  const question = noteKind === "question"
  const setQuestion = (value: boolean) =>
    setNoteKind(value ? "question" : "note")
  const [editorKey, setEditorKey] = useState(0)
  const notes = workspace.review.annotations.filter(
    (n) => n.anchor.passageId === anchor?.passageId
  )
  const step = workspace.review.topics
    .flatMap((t) => t.steps)
    .find((s) => s.anchors.some((a) => a.passageId === anchor?.passageId))
  const topic = workspace.review.topics.find((t) =>
    t.steps.some((s) => s.id === step?.id)
  )
  const status = anchor ? passageStatus(workspace, anchor) : "Unread"
  const validated = workspace.review.decisions.some(
    (d) =>
      d.anchor.snapshotId === anchor?.snapshotId &&
      d.anchor.passageId === anchor?.passageId
  )
  const validAnchor =
    anchor?.snapshotId === workspace.snapshot.id && status !== "Re-review"
  return (
    <aside className="flex w-full min-w-0 flex-col">
      <div className="flex h-12 shrink-0 items-center border-b px-3">
        <Tabs
          value={inspector}
          onValueChange={(v) => setInspector(v as typeof inspector)}
        >
          <TabsList variant="line">
            <TabsTrigger value="explanation">Explanation</TabsTrigger>
            <TabsTrigger value="notes">Notes · {notes.length}</TabsTrigger>
            <TabsTrigger value="ask">Ask agent</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-5">
        {inspector === "explanation" && (
          <div className="space-y-5">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{step ? "Guided review" : "Outside the tour"}</span>
              <div>
                <Button
                  variant="ghost"
                  size="xs"
                  aria-label="Previous passage"
                  onClick={() => onNext(-1)}
                >
                  ↑
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  aria-label="Next passage"
                  onClick={() => onNext(1)}
                >
                  ↓
                </Button>
              </div>
            </div>
            <h2 className="flex items-start gap-2 text-base font-medium">
              <ReviewStatus status={status} />
              {step?.title ?? "Read this change"}
            </h2>
            <p className="text-sm leading-6 whitespace-pre-wrap">
              {step?.explanation ||
                "Check the behavior, surrounding context and possible effects before validating this passage."}
            </p>
            {topic?.brief && (
              <details open className="text-sm">
                <summary className="cursor-pointer font-medium">
                  Topic brief · goal, expected behavior, risks
                </summary>
                <p className="mt-3 leading-6 whitespace-pre-wrap text-muted-foreground">
                  {topic.brief}
                </p>
              </details>
            )}
            <div className="rounded-xl border p-3 text-xs leading-5 text-muted-foreground">
              A human decision validates this passage. Shared decisions retain
              their author; agent suggestions do not validate code.
            </div>
            {workspace.review.decisions
              .filter(
                (decision) =>
                  decision.anchor.snapshotId === anchor?.snapshotId &&
                  decision.anchor.passageId === anchor?.passageId
              )
              .map((decision) => (
                <p
                  key={decision.id}
                  className="text-xs text-muted-foreground"
                  title={decision.author}
                >
                  Validated by {decision.author} ·{" "}
                  {new Date(Number(decision.createdAt)).toLocaleString()}
                </p>
              ))}
            <EvidencePanel
              reviewId={workspace.review.id}
              snapshotId={workspace.snapshot.id}
            />
            {status === "Re-review" && (
              <p className="text-sm text-review-attention">
                This anchor belongs to an older version. Edit the topic to
                associate the current passage.
              </p>
            )}
          </div>
        )}
        {inspector === "notes" && (
          <div className="space-y-4">
            {notes.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No notes on this passage yet.
              </p>
            )}
            {notes.map((note) => (
              <article key={note.id} className="rounded-xl border p-3">
                <div className="mb-3 flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    {note.question
                      ? note.resolved
                        ? "Resolved question"
                        : "Open question"
                      : "Note"}{" "}
                    ·{" "}
                    {note.author.startsWith("human")
                      ? `Human · ${note.author.split(":")[1]?.slice(0, 8) ?? "legacy"}`
                      : "Agent suggestion · unverified"}
                  </span>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() =>
                      onAction({ kind: "deleteAnnotation", id: note.id })
                    }
                  >
                    Delete
                  </Button>
                </div>
                <RichTextEditor
                  editable={false}
                  initialContent={noteContent(note.body)}
                  className="text-sm"
                />
                {note.question && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    disabled={busy}
                    onClick={() =>
                      onAction({
                        kind: "resolveQuestion",
                        id: note.id,
                        resolved: !note.resolved,
                      })
                    }
                  >
                    {note.resolved ? "Reopen question" : "Resolve question"}
                  </Button>
                )}
              </article>
            ))}
            {validAnchor && (
              <div className="space-y-3 border-t pt-4">
                <div className="flex gap-2">
                  <Button
                    variant={question ? "ghost" : "secondary"}
                    size="sm"
                    onClick={() => setQuestion(false)}
                  >
                    Note
                  </Button>
                  <Button
                    variant={question ? "secondary" : "ghost"}
                    size="sm"
                    onClick={() => setQuestion(true)}
                  >
                    Question
                  </Button>
                </div>
                <RichTextEditor
                  key={editorKey}
                  ariaLabel="Write a note"
                  onChange={setDraft}
                  className="min-h-28 rounded-xl border p-3"
                />
                <Button
                  disabled={!draft || busy}
                  onClick={() => {
                    if (!anchor || !draft) return
                    onAction({
                      kind: "addAnnotation",
                      anchor,
                      body: JSON.stringify(draft),
                      question,
                    })
                    setDraft(null)
                    setEditorKey(editorKey + 1)
                  }}
                >
                  Save {question ? "question" : "note"}
                </Button>
              </div>
            )}
          </div>
        )}
        {inspector === "ask" && (
          <AgentConversation
            onApplied={onApplied}
            reviewId={workspace.review.id}
            snapshot={workspace.snapshot}
            initialPath={
              workspace.snapshot.changes.find((c) => c.id === anchor?.changeId)
                ?.path
            }
            onSave={(run) => {
              if (anchor)
                onAction({ kind: "keepAgentNote", anchor, runId: run.id })
            }}
          />
        )}
      </div>
      <footer className="space-y-3 border-t p-4">
        <div className="flex gap-2">
          <Button
            className="flex-1"
            disabled={!validAnchor || busy}
            onClick={() =>
              anchor &&
              onAction({ kind: validated ? "reopen" : "validate", anchor })
            }
          >
            {validated ? "Reopen passage" : "✓ Validate passage"}
          </Button>
          <Button
            variant="outline"
            disabled={!validAnchor}
            onClick={() => {
              setQuestion(true)
              setInspector("notes")
            }}
          >
            Question
          </Button>
        </div>
        <Button
          className="w-full"
          variant="ghost"
          size="xs"
          disabled={!validAnchor || busy}
          onClick={() => anchor && onAction({ kind: "examine", anchor })}
        >
          Mark as examined
        </Button>
        <p className="text-[11px] leading-4 text-muted-foreground">
          Bound to this exact content. Changed passages require another review.
        </p>
      </footer>
    </aside>
  )
}
