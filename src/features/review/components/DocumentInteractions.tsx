"use client"
import { useEffect, useRef, useState, type ComponentProps } from "react"
import { createPortal } from "react-dom"
import { Button } from "@/components/ui/button"
import { ReviewMarkdown } from "@/features/markdown/components/ReviewMarkdown"
import { openRevChat } from "@/features/rev-chat/stores/revChat.store"
import type {
  DocumentCommentAnchor,
  DocumentTerm,
} from "@/lib/desktop/contracts.generated"
import type { ReviewCommentsSession } from "../hooks/useReviewComments"
import {
  documentHash,
  documentRanges,
} from "../helpers/documentSelection.helpers"
import { ReviewCommentDialog } from "./ReviewCommentDialog"

type SelectionState = { anchor: DocumentCommentAnchor; x: number; y: number }
export function DocumentInteractions({
  repositoryId,
  stepId,
  title,
  session,
  ...props
}: ComponentProps<typeof ReviewMarkdown> & {
  repositoryId: string
  stepId: string
  title: string
  session: ReviewCommentsSession
}) {
  const root = useRef<HTMLDivElement>(null)
  const generation = useRef(0)
  const [selection, setSelection] = useState<SelectionState | null>(null)
  const [draft, setDraft] = useState<DocumentCommentAnchor | null>(null)
  const [draftText, setDraftText] = useState("")
  const identity = `${props.snapshotId}/${stepId}/${props.level}`
  const pendingHash = useRef<Promise<string> | null>(null)
  useEffect(() => {
    const version = generation
    pendingHash.current = documentHash(props.document.body)
    const update = () => {
      const token = ++generation.current
      const value = window.getSelection()
      if (!root.current || !value) return
      const ranges = documentRanges(root.current, value)
      if (!ranges) {
        setSelection(null)
        return
      }
      const rect = value.getRangeAt(0).getBoundingClientRect()
      const excerpt = value.toString()
      void pendingHash.current?.then((contentHash) => {
        if (token !== generation.current) return
        setSelection({
          anchor: {
            title,
            document: {
              snapshotId: props.snapshotId,
              stepId,
              level: props.level,
              contentHash,
              ranges,
            },
            excerpt,
          },
          x: Math.max(8, Math.min(rect.left, window.innerWidth - 240)),
          y: Math.max(64, Math.min(rect.bottom + 8, window.innerHeight - 120)),
        })
      })
    }
    document.addEventListener("selectionchange", update)
    return () => {
      version.current++
      document.removeEventListener("selectionchange", update)
    }
  }, [props.document.body, props.snapshotId, props.level, stepId, title])
  const askTerm = async (term: DocumentTerm) => {
    const contentHash = await (pendingHash.current ??
      documentHash(props.document.body))
    openRevChat(
      repositoryId,
      props.reviewId,
      {
        title: `${title} · ${props.level} · ${term.term}`,
        excerpt: term.definition,
        context: {
          selection: {
            snapshotId: props.snapshotId,
            stepId,
            level: props.level,
            contentHash,
            ranges: [],
          },
          termId: term.id,
        },
      },
      `Explain what “${term.term}” means in this context.`
    )
  }
  const current = selection?.anchor.document
  const applicable =
    current &&
    `${current.snapshotId}/${current.stepId}/${current.level}` === identity
  return (
    <>
      <div ref={root} data-review-document>
        <ReviewMarkdown
          {...props}
          selectable
          onAskTerm={(term) => void askTerm(term)}
        />
      </div>
      {applicable &&
        selection &&
        !draft &&
        createPortal(
          <div
            role="toolbar"
            aria-label="Document selection"
            className="fixed z-[60] flex gap-1 rounded-2xl border bg-popover p-1 shadow-lg"
            style={{ left: selection.x, top: selection.y }}
            onMouseDown={(event) => event.preventDefault()}
          >
            {session.editable && (
              <Button
                size="xs"
                variant="secondary"
                disabled={session.busy || !session.document}
                onClick={() => setDraft(selection.anchor)}
              >
                Add comment
              </Button>
            )}
            <Button
              size="xs"
              variant="secondary"
              onClick={() => {
                openRevChat(repositoryId, props.reviewId, {
                  title: `${title} · ${props.level}`,
                  excerpt: selection.anchor.excerpt,
                  context: {
                    selection: selection.anchor.document,
                    termId: null,
                  },
                })
                setSelection(null)
              }}
            >
              Ask Rev
            </Button>
          </div>,
          document.body
        )}
      {draft && (
        <ReviewCommentDialog
          anchor={draft}
          busy={session.busy}
          error={session.error}
          initialText={draftText}
          onSave={session.mutate}
          onReselect={(text) => {
            setDraftText(text)
            setDraft(null)
            setSelection(null)
          }}
          onClose={() => {
            setDraft(null)
            setDraftText("")
          }}
        />
      )}
    </>
  )
}
