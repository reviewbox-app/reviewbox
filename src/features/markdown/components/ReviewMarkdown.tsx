"use client"

import { useCallback, useEffect, useState, type ReactNode } from "react"
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
  ReviewFileContent,
} from "@/lib/desktop/contracts.generated"
import { errorMessage } from "@/lib/desktop/review.commands"
import { readerCommands } from "@/features/review/services/reader.commands"
import { ReviewIllustration } from "./ReviewIllustration"
import { MermaidBlock } from "./MermaidBlock"
import { MarkdownRenderer } from "./MarkdownRenderer"
import { MarkdownCodeBlock } from "./MarkdownCodeBlock"
import { resolveCodeLanguage } from "@/lib/code/languages"

interface Context {
  level: ReadingLevel
  reviewId: string
  snapshotId: string
  files: ReviewFile[]
  glossary?: DocumentTerm[]
  sourceMode?: "real" | "pseudo"
}

/** The same lexer colors the diff, inline blocks and reference cards. */
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
  level,
  reviewId,
  snapshotId,
  files,
  sourceMode = "real",
}: Context & { reference: DocumentReference }) {
  const [content, setContent] = useState<{
    key: string
    text?: string | null
    error?: string
    path?: string
  } | null>(null)
  const pseudo = level === "intermediate" || sourceMode === "pseudo"
  const key = `${reviewId}/${snapshotId}/${reference.sourceId}/${reference.startLine}/${reference.endLine}/${pseudo}/${level}`
  useEffect(() => {
    if (level === "beginner") return
    let alive = true
    const load = async () => {
      if (pseudo) {
        let file =
          files.find((f) =>
            f.translations.some((t) => t.sourceId === reference.sourceId)
          ) ?? files.find((f) => reference.sourceId === `file:${f.path}`)
        let sourceHash: string | undefined
        if (!file) {
          // A context-file ID may address the exact same frozen bytes as a
          // change side. Reuse that translation only after checking identity.
          const source = await readerCommands.source(
            snapshotId,
            reference.sourceId
          )
          sourceHash = source.hash
          file = files.find((f) =>
            f.translations.some((t) => t.sourceHash === sourceHash)
          )
        }
        if (!file)
          throw new Error("Pseudo-code is unavailable for this reference.")
        const data: ReviewFileContent = await readerCommands.file(
          reviewId,
          file.id
        )
        if (data.pseudocodeSelected === false || data.pseudocodeSkipReason)
          return null
        const translation = data.translations.find(
          (t) =>
            t.sourceId === reference.sourceId ||
            (sourceHash !== undefined && t.sourceHash === sourceHash)
        )
        if (!translation || translation.unavailableReason)
          throw new Error(
            translation?.unavailableReason ||
              "Pseudo-code is unavailable for this reference."
          )
        const blocks = translation.blocks.filter(
          (b) =>
            b.endLine >= reference.startLine && b.startLine <= reference.endLine
        )
        if (!blocks.length) throw new Error("No pseudo-code for this passage")
        return { text: blocks.map((b) => b.text).join("\n\n") }
      }
      const source = await readerCommands.source(snapshotId, reference.sourceId)
      if (source.text === null)
        throw new Error(
          source.unavailableReason || "This captured source is unavailable."
        )
      const lines = source.text.split("\n")
      if (
        reference.startLine < 1 ||
        reference.endLine < reference.startLine ||
        reference.endLine > lines.length
      )
        throw new Error("This reference is outside the captured source.")
      return {
        text: lines
          .slice(reference.startLine - 1, reference.endLine)
          .join("\n"),
        path: source.path,
      }
    }
    void load()
      .then((result) => {
        if (alive) setContent({ key, ...(result ?? { text: null }) })
      })
      .catch((e) => {
        if (alive) setContent({ key, error: errorMessage(e) })
      })
    return () => {
      alive = false
    }
  }, [
    key,
    files,
    level,
    pseudo,
    reference.sourceId,
    reference.startLine,
    reference.endLine,
    reviewId,
    snapshotId,
  ])
  return (
    <div className="markdown min-w-0 space-y-2">
      <p className="text-sm leading-6 text-muted-foreground">
        {reference.explanation}
      </p>
      {level !== "beginner" &&
        (content?.key !== key ? (
          <p role="status" className="text-xs text-muted-foreground">
            Loading the captured reference…
          </p>
        ) : content.error ? (
          <p role="status" className="text-sm text-muted-foreground">
            {content.error}
          </p>
        ) : content.text === null ? null : pseudo ? (
          <PseudoCode text={content.text ?? ""} />
        ) : (
          <MarkdownCodeBlock
            source={content.text ?? ""}
            language={resolveCodeLanguage(content.path ?? "").id}
            label="Captured source"
          />
        ))}
    </div>
  )
}

function ReferenceLink({
  children,
  reference,
  onOpenReference,
  ...context
}: Context & {
  children: ReactNode
  reference: DocumentReference
  onOpenReference?: (reference: DocumentReference) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <HoverCard>
        <HoverCardTrigger
          render={<button type="button" />}
          onClick={() => setOpen(true)}
          className="cursor-pointer rounded-sm text-primary underline decoration-primary/35 decoration-dotted underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {children}
        </HoverCardTrigger>
        <HoverCardContent className="max-h-96 w-96 max-w-[85vw] overflow-y-auto">
          <p className="mb-1 font-medium">{reference.label}</p>
          <ReviewReferenceContent reference={reference} {...context} />
        </HoverCardContent>
      </HoverCard>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{reference.label}</DialogTitle>
            <DialogDescription>
              Reference from this review’s captured changes.
            </DialogDescription>
          </DialogHeader>
          <ReviewReferenceContent reference={reference} {...context} />
          {onOpenReference && (
            <Button
              variant="secondary"
              onClick={() => {
                onOpenReference(reference)
                setOpen(false)
              }}
            >
              Open alongside the document
            </Button>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

function TermLink({
  children,
  term,
  definition,
  context,
}: {
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
        </HoverCardContent>
      </HoverCard>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{term}</DialogTitle>
            <DialogDescription>{definition}</DialogDescription>
          </DialogHeader>
          <p className="text-sm leading-6 text-muted-foreground">{context}</p>
        </DialogContent>
      </Dialog>
    </>
  )
}

export function ReviewMarkdown({
  document,
  onOpenReference,
  className,
  ...context
}: Context & {
  document: ReviewDocument
  onOpenReference?: (reference: DocumentReference) => void
  className?: string
}) {
  const [openedTerm, setOpenedTerm] = useState<DocumentTerm | null>(null)
  const [openedReference, setOpenedReference] =
    useState<DocumentReference | null>(null)
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
            {...context}
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
        <TermLink {...term}>{children}</TermLink>
      ) : (
        <span title="This definition is unavailable">{children}</span>
      )
    },
    [context, document.references, document.terms, onOpenReference]
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
                if (onOpenReference) onOpenReference(reference)
                else setOpenedReference(reference)
              }
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
          <ReviewReferenceContent reference={reference} {...context} />
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
            showSource={context.level === "developer"}
          />
        )
      // Real source is only rendered by a verified source reference, never a model-authored fence.
      return (
        <p className="text-xs text-muted-foreground">
          Use a captured reference to explore this code.
        </p>
      )
    },
    [context, document, onOpenReference]
  )
  return (
    <>
      <MarkdownRenderer
        className={className}
        allowHtml={false}
        glossary={[...(context.glossary ?? []), ...document.terms]}
        illustrations
        renderLink={link}
        renderCodeBlock={block}
      >
        {document.body}
      </MarkdownRenderer>
      <Dialog
        open={!!openedTerm || !!openedReference}
        onOpenChange={(open) => {
          if (!open) {
            setOpenedTerm(null)
            setOpenedReference(null)
          }
        }}
      >
        <DialogContent className="max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {openedTerm?.term ?? openedReference?.label}
            </DialogTitle>
            <DialogDescription>
              {openedTerm?.definition ??
                "Reference from this review’s captured changes."}
            </DialogDescription>
          </DialogHeader>
          {openedTerm && (
            <p className="text-sm text-muted-foreground">
              {openedTerm.context}
            </p>
          )}
          {openedReference && (
            <ReviewReferenceContent reference={openedReference} {...context} />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
