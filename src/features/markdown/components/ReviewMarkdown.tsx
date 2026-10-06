"use client"

import { useCallback, useRef, useState, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card"
import type {
  DocumentReference,
  DocumentTerm,
  ReadingLevel,
  ReviewDocument,
  ReviewFile,
} from "@/lib/desktop/contracts.generated"
import { ReviewIllustration } from "./ReviewIllustration"
import { MermaidBlock } from "./MermaidBlock"
import { MarkdownRenderer } from "./MarkdownRenderer"
import { MarkdownCodeBlock } from "./MarkdownCodeBlock"

interface Context {
  level: ReadingLevel
  reviewId: string
  snapshotId: string
  files: ReviewFile[]
  glossary?: DocumentTerm[]
}

/** Keep legacy Markdown blocks on the shared syntax highlighter. */
export function PseudoCode({ text }: { text: string }) {
  return (
    <MarkdownCodeBlock
      source={text}
      language="pseudocode"
      label="Pseudo-code"
    />
  )
}

export function ReviewReferenceContent({
  reference,
  onOpenReference,
}: {
  reference: DocumentReference
  onOpenReference?: (reference: DocumentReference) => void
}) {
  return (
    <div className="markdown min-w-0 space-y-2">
      <p className="text-sm leading-6 text-muted-foreground">
        {reference.explanation}
      </p>
      {onOpenReference && (
        <Button variant="secondary" onClick={() => onOpenReference(reference)}>
          Open in code
        </Button>
      )}
    </div>
  )
}

function ReferenceLink({
  children,
  reference,
  onOpenReference,
}: {
  children: ReactNode
  reference: DocumentReference
  onOpenReference?: (reference: DocumentReference) => void
}) {
  const [open, setOpen] = useState(false)
  const card = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLElement | null>(null)
  return (
    <HoverCard open={open} onOpenChange={setOpen}>
      <HoverCardTrigger
        ref={(element) => {
          trigger.current = element
        }}
        render={<button type="button" />}
        onClick={() => setOpen(true)}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false)
          if (event.key === "Tab" && !event.shiftKey && open) {
            const action =
              card.current?.querySelector<HTMLButtonElement>("button")
            if (action) {
              event.preventDefault()
              action.focus()
            }
          }
        }}
        className="cursor-pointer rounded-sm text-primary underline decoration-primary/35 decoration-dotted underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {children}
      </HoverCardTrigger>
      <HoverCardContent
        ref={card}
        className="max-h-96 w-96 max-w-[85vw] overflow-y-auto"
        onKeyDown={(event) => {
          if (
            event.key === "Escape" ||
            (event.key === "Tab" && event.shiftKey)
          ) {
            event.preventDefault()
            trigger.current?.focus()
            if (event.key === "Escape") setOpen(false)
          }
        }}
      >
        <p className="mb-1 font-medium">{reference.label}</p>
        <ReviewReferenceContent
          reference={reference}
          onOpenReference={
            onOpenReference
              ? (value) => {
                  setOpen(false)
                  onOpenReference(value)
                }
              : undefined
          }
        />
      </HoverCardContent>
    </HoverCard>
  )
}

function TermLink({
  children,
  term,
  definition,
  context,
  onAsk,
}: {
  onAsk?: () => void
  children: ReactNode
  term: string
  definition: string
  context: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <HoverCard>
        <HoverCardTrigger
          render={<button type="button" />}
          className="cursor-pointer rounded-sm underline decoration-muted-foreground/50 decoration-dotted underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setOpen(true)}
        >
          {children}
        </HoverCardTrigger>
        <HoverCardContent>
          <p className="font-medium">{term}</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {definition}
          </p>
          {onAsk && (
            <Button
              size="xs"
              variant="secondary"
              className="mt-2"
              onClick={onAsk}
            >
              Ask Rev
            </Button>
          )}
        </HoverCardContent>
      </HoverCard>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{term}</DialogTitle>
            <DialogDescription>{definition}</DialogDescription>
          </DialogHeader>
          <p className="text-sm leading-6 text-muted-foreground">{context}</p>
          {onAsk && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setOpen(false)
                onAsk()
              }}
            >
              Ask Rev
            </Button>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

export function ReviewMarkdown({
  document,
  onOpenReference,
  className,
  onAskTerm,
  selectable = false,
  ...context
}: Context & {
  document: ReviewDocument
  onOpenReference: (reference: DocumentReference) => void
  className?: string
  selectable?: boolean
  onAskTerm?: (term: DocumentTerm) => void
}) {
  const [openedTerm, setOpenedTerm] = useState<DocumentTerm | null>(null)
  const [referenceError, setReferenceError] = useState("")
  const link = useCallback(
    (href: string, children: ReactNode) => {
      const match = /^reviewbox:(ref|term)\/([a-zA-Z0-9_-]+)$/.exec(href)
      if (!match) return undefined
      if (match[1] === "ref") {
        const reference = document.references.find((r) => r.id === match[2])
        return reference ? (
          <ReferenceLink
            reference={reference}
            onOpenReference={onOpenReference}
          >
            {children}
          </ReferenceLink>
        ) : (
          <span
            title="This reference is unavailable"
            className="text-muted-foreground"
          >
            {children}
          </span>
        )
      }
      const term = [...document.terms, ...(context.glossary ?? [])].find(
        (t) => t.id === match[2]
      )
      return term ? (
        <TermLink
          {...term}
          onAsk={onAskTerm ? () => onAskTerm(term) : undefined}
        >
          {children}
        </TermLink>
      ) : (
        <span title="This definition is unavailable">{children}</span>
      )
    },
    [context, document.references, document.terms, onOpenReference, onAskTerm]
  )
  const block = useCallback(
    (source: string, language?: string): ReactNode | undefined => {
      if (language === "html")
        return (
          <ReviewIllustration
            key={source}
            source={source}
            onReference={(id) => {
              const reference = document.references.find((r) => r.id === id)
              if (reference) {
                setReferenceError("")
                onOpenReference(reference)
              } else
                setReferenceError("This captured reference is unavailable.")
            }}
            onTerm={(id) => {
              const term = [
                ...document.terms,
                ...(context.glossary ?? []),
              ].find(
                (t) =>
                  t.id === (document.termAliases?.[id] ?? id) &&
                  (document.terms.some((local) => local.id === t.id) ||
                    document.body
                      .toLowerCase()
                      .includes(t.term.toLowerCase()) ||
                    document.body.includes(`reviewbox:term/${t.id}`) ||
                    !!document.termAliases?.[id])
              )
              if (term) setOpenedTerm(term)
            }}
          />
        )
      if (language === "summary")
        return (
          <aside className="my-5 rounded-xl border bg-muted/40 px-4 py-3">
            <ReviewMarkdown
              document={{ ...document, body: source }}
              {...context}
              onAskTerm={onAskTerm}
              onOpenReference={onOpenReference}
            />
          </aside>
        )
      if (language === "before-after") {
        try {
          const value: unknown = JSON.parse(source)
          if (
            !value ||
            typeof value !== "object" ||
            !("before" in value) ||
            !("after" in value) ||
            !Array.isArray(value.before) ||
            !Array.isArray(value.after) ||
            ![...value.before, ...value.after].every(
              (v) => typeof v === "string"
            )
          )
            throw new Error()
          return (
            <div className="not-prose my-6 grid gap-3 sm:grid-cols-2">
              {[
                ["Before", value.before],
                ["Now", value.after],
              ].map(([title, items]) => (
                <section
                  key={title as string}
                  className="rounded-xl border bg-muted/30 p-4"
                >
                  <h4 className="mb-3 text-xs font-medium text-muted-foreground">
                    {title}
                  </h4>
                  <ol className="space-y-3">
                    {(items as string[]).map((item, i) => (
                      <li key={i} className="flex gap-2 text-sm leading-6">
                        <span className="text-muted-foreground">{i + 1}.</span>
                        <span>{item}</span>
                      </li>
                    ))}
                  </ol>
                </section>
              ))}
            </div>
          )
        } catch {
          return (
            <p className="text-sm text-muted-foreground">
              This comparison is unavailable.
            </p>
          )
        }
      }
      if (language === "source") {
        const reference = document.references.find(
          (r) => r.id === source.trim()
        )
        return reference ? (
          <section className="my-4 space-y-2 rounded-lg border p-4">
            <p className="font-medium">{reference.label}</p>
            <ReviewReferenceContent
              reference={reference}
              onOpenReference={onOpenReference}
            />
          </section>
        ) : (
          <p className="text-sm text-muted-foreground">
            This captured reference is unavailable.
          </p>
        )
      }
      if (language === "pseudocode") return <PseudoCode text={source} />
      if (language === "mermaid")
        return (
          <MermaidBlock
            chart={source.trim()}
            showSource={context.level === "technical"}
          />
        )
      // Real source is only rendered by a verified source reference, never a model-authored fence.
      return (
        <p className="text-xs text-muted-foreground">
          Use a captured reference to explore this code.
        </p>
      )
    },
    [context, document, onOpenReference, onAskTerm]
  )
  return (
    <>
      <MarkdownRenderer
        className={className}
        allowHtml={false}
        selectable={selectable}
        glossary={[...(context.glossary ?? []), ...document.terms]}
        illustrations
        renderLink={link}
        renderCodeBlock={block}
      >
        {document.body}
      </MarkdownRenderer>
      {referenceError && <p role="alert">{referenceError}</p>}
      <Dialog
        open={!!openedTerm}
        onOpenChange={(open) => {
          if (!open) {
            setOpenedTerm(null)
          }
        }}
      >
        <DialogContent className="max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{openedTerm?.term}</DialogTitle>
            <DialogDescription>{openedTerm?.definition}</DialogDescription>
          </DialogHeader>
          {openedTerm && onAskTerm && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                onAskTerm(openedTerm)
                setOpenedTerm(null)
              }}
            >
              Ask Rev
            </Button>
          )}
          {openedTerm && (
            <p className="text-sm text-muted-foreground">
              {openedTerm.context}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
