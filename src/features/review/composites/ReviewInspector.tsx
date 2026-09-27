"use client"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AgentConversation } from "@/features/agents/composites/AgentConversation"
import { EvidencePanel } from "@/features/evidence/composites/EvidencePanel"
import type {
  CodeAnchor,
  ReviewAction,
  Workspace,
} from "@/lib/desktop/contracts.generated"
import { DecisionBar } from "../components/DecisionBar"
import { NoteComposer } from "../components/NoteComposer"
import { NotesList } from "../components/NotesList"
import { StepExplanation } from "../components/StepExplanation"
import {
  anchorLabel,
  authorOf,
  isValidated,
  linesLabel,
  passageStatus,
  readingStep,
  shortTime,
} from "../helpers/review.helpers"
import { useReviewWorkspaceStore } from "../stores/useReviewWorkspace.store"

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
  onAction: (action: ReviewAction) => Promise<boolean>
  onNext: (direction: number) => void
  onApplied: () => void
}) {
  const { inspector, setInspector, noteKind, setNoteKind } =
    useReviewWorkspaceStore()
  const { review, snapshot } = workspace
  const notes = review.annotations.filter(
    (n) => n.anchor.passageId === anchor?.passageId
  )
  const reading = readingStep(review, anchor)
  const topic = reading?.topic
  const stepIndex = reading?.index ?? -1
  const step = reading?.step
  const change = snapshot.changes.find((c) => c.id === anchor?.changeId)
  const passage = change?.passages.find((p) => p.id === anchor?.passageId)
  const status = anchor ? passageStatus(workspace, anchor) : "Unread"
  const decision =
    anchor && passage && isValidated(review, anchor, passage.fingerprint)
      ? review.decisions.findLast(
          (d) =>
            d.anchor.passageId === anchor.passageId &&
            d.fingerprint === passage.fingerprint
        )
      : undefined
  const validAnchor =
    anchor?.snapshotId === snapshot.id && status !== "Re-review"
  const openNotes = notes.filter((n) => n.question && !n.resolved).length
  return (
    <aside className="@container relative flex w-full min-w-0 flex-col">
      <div className="flex h-12 shrink-0 items-end border-b px-2 @[340px]:px-4">
        <Tabs
          className="w-full min-w-0"
          value={inspector}
          onValueChange={(v) => setInspector(v as typeof inspector)}
        >
          <TabsList
            variant="line"
            className="w-full gap-0 pb-1.5 [&_[role=tab]]:px-1 [&_[role=tab]]:text-xs @[340px]:[&_[role=tab]]:px-3 @[340px]:[&_[role=tab]]:text-sm"
          >
            <TabsTrigger value="explanation">Explanation</TabsTrigger>
            <TabsTrigger value="notes">
              Notes · {notes.length}
              {openNotes > 0 && (
                <span
                  aria-label={`${openNotes} open`}
                  className="size-1.5 rounded-full bg-review-question"
                />
              )}
            </TabsTrigger>
            <TabsTrigger value="ask">Ask Rev</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {inspector === "ask" ? (
        <AgentConversation
          className="min-h-0 flex-1"
          onApplied={onApplied}
          reviewId={review.id}
          snapshot={snapshot}
          initialPath={change?.path}
          contextLabel={
            step
              ? `Step ${stepIndex + 1} · ${anchorLabel(workspace, anchor ?? undefined)}`
              : (anchorLabel(workspace, anchor ?? undefined) ?? undefined)
          }
          onSave={(run) => {
            if (anchor)
              onAction({ kind: "keepAgentNote", anchor, runId: run.id })
          }}
        />
      ) : (
        <>
          <div className="min-h-0 flex-1 scrollbar-none overflow-auto px-5 pt-5 pb-44 wrap-anywhere">
            {inspector === "explanation" ? (
              <StepExplanation
                position={
                  topic && step
                    ? `Step ${stepIndex + 1} of ${topic.steps.length} · ${topic.title}`
                    : "Outside the tour"
                }
                title={
                  step?.title ??
                  (change
                    ? `Read ${change.path.split("/").at(-1)}`
                    : "Read this change")
                }
                status={status}
                anchor={anchorLabel(workspace, anchor ?? undefined)}
                explanation={
                  step?.explanation ||
                  "Check the behavior, the surrounding context and possible effects before validating this passage."
                }
                brief={topic?.brief}
                validation={
                  decision
                    ? `Validated by ${authorOf(decision.author).name} · ${shortTime(decision.createdAt)}`
                    : undefined
                }
                onStep={onNext}
              >
                <EvidencePanel reviewId={review.id} snapshotId={snapshot.id} />
              </StepExplanation>
            ) : (
              <NotesList
                notes={notes}
                busy={busy}
                onResolve={(note) =>
                  onAction({
                    kind: "resolveQuestion",
                    id: note.id,
                    resolved: !note.resolved,
                  })
                }
                onDelete={(note) =>
                  onAction({ kind: "deleteAnnotation", id: note.id })
                }
              />
            )}
          </div>
          <footer className="absolute inset-x-0 bottom-0 glass-bar">
            <div className="pointer-none: absolute -top-6 left-0 h-6 w-full bg-linear-0 from-popover to-transparent" />

            {inspector === "notes" && validAnchor ? (
              <NoteComposer
                kind={noteKind}
                disabled={busy}
                onKind={setNoteKind}
                onSubmit={(body, question) =>
                  anchor
                    ? onAction({
                        kind: "addAnnotation",
                        anchor,
                        body: JSON.stringify(body),
                        question,
                      })
                    : Promise.resolve(false)
                }
              />
            ) : (
              <DecisionBar
                validated={!!decision}
                disabled={!validAnchor || busy}
                binding={`Bound to content ${snapshot.id.slice(0, 6)}${passage ? ` · ${linesLabel(passage)}` : ""}.`}
                onValidate={() =>
                  anchor && onAction({ kind: "validate", anchor })
                }
                onReopen={() => anchor && onAction({ kind: "reopen", anchor })}
                onExamine={() =>
                  anchor && onAction({ kind: "examine", anchor })
                }
                onQuestion={() => {
                  setNoteKind("question")
                  setInspector("notes")
                }}
              />
            )}
          </footer>
        </>
      )}
    </aside>
  )
}
