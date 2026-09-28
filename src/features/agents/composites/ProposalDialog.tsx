"use client"
import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import type {
  Proposal,
  ProposalContent,
} from "@/lib/desktop/contracts.generated"
import { errorMessage } from "@/lib/desktop/review.commands"
import { agentCommands } from "../services/agent.commands"

export function ProposalDialog({
  proposal,
  onClose,
  onAccepted,
}: {
  proposal: Proposal
  onClose: () => void
  onAccepted: () => void
}) {
  const [content, setContent] = useState<ProposalContent>(proposal.content)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const answer = async (accepted: boolean) => {
    setBusy(true)
    setError("")
    try {
      await agentCommands.answer(
        proposal.id,
        proposal.revision,
        content,
        accepted
      )
      if (accepted) onAccepted()
      onClose()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogTitle>
          Review the proposed{" "}
          {content.kind === "topics"
            ? "topics"
            : content.kind === "glossary"
              ? "definitions"
              : "explanation"}
        </DialogTitle>
        <DialogDescription>
          Edit or remove suggestions before accepting. Your code and validation
          decisions stay under your control.
        </DialogDescription>
        <div className="min-h-0 space-y-5 overflow-auto py-2">
          {content.kind === "topics" &&
            content.topics.map((topic, index) => (
              <section
                key={topic.id}
                className="space-y-3 rounded-xl border p-4"
              >
                <Input
                  aria-label="Proposed topic title"
                  value={topic.title}
                  onChange={(e) =>
                    setContent({
                      ...content,
                      topics: content.topics.map((t, i) =>
                        i === index ? { ...t, title: e.target.value } : t
                      ),
                    })
                  }
                />
                <Textarea
                  aria-label="Proposed topic brief"
                  value={topic.brief}
                  onChange={(e) =>
                    setContent({
                      ...content,
                      topics: content.topics.map((t, i) =>
                        i === index ? { ...t, brief: e.target.value } : t
                      ),
                    })
                  }
                />
                {topic.steps.map((step, stepIndex) => (
                  <div key={step.id} className="space-y-2 border-l pl-3">
                    <Input
                      aria-label="Proposed step title"
                      value={step.title}
                      onChange={(e) =>
                        setContent({
                          ...content,
                          topics: content.topics.map((t, i) =>
                            i === index
                              ? {
                                  ...t,
                                  steps: t.steps.map((s, j) =>
                                    j === stepIndex
                                      ? { ...s, title: e.target.value }
                                      : s
                                  ),
                                }
                              : t
                          ),
                        })
                      }
                    />
                    <Textarea
                      aria-label="Proposed step explanation"
                      value={step.documents.intermediate.body}
                      onChange={(e) =>
                        setContent({
                          ...content,
                          topics: content.topics.map((t, i) =>
                            i === index
                              ? {
                                  ...t,
                                  steps: t.steps.map((s, j) =>
                                    j === stepIndex
                                      ? {
                                          ...s,
                                          documents: {
                                            ...s.documents,
                                            intermediate: {
                                              ...s.documents.intermediate,
                                              body: e.target.value,
                                            },
                                          },
                                        }
                                      : s
                                  ),
                                }
                              : t
                          ),
                        })
                      }
                    />
                    <p className="text-xs text-muted-foreground">
                      {step.anchors.length} source anchors
                    </p>
                  </div>
                ))}
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() =>
                    setContent({
                      ...content,
                      topics: content.topics.filter((_, i) => i !== index),
                    })
                  }
                >
                  Remove topic
                </Button>
              </section>
            ))}
          {content.kind === "explanation" && (
            <>
              <p className="font-mono text-xs">{content.path}</p>
              {content.sections.map((section, index) => (
                <section
                  key={section.id}
                  className="space-y-3 rounded-xl border p-4"
                >
                  <Input
                    aria-label="Section title"
                    value={section.title}
                    onChange={(e) =>
                      setContent({
                        ...content,
                        sections: content.sections.map((s, i) =>
                          i === index ? { ...s, title: e.target.value } : s
                        ),
                      })
                    }
                  />
                  <Textarea
                    aria-label="Section explanation"
                    value={section.body}
                    onChange={(e) =>
                      setContent({
                        ...content,
                        sections: content.sections.map((s, i) =>
                          i === index ? { ...s, body: e.target.value } : s
                        ),
                      })
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    Lines {section.startLine}–{section.endLine}
                  </p>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      setContent({
                        ...content,
                        sections: content.sections.filter(
                          (_, i) => i !== index
                        ),
                      })
                    }
                  >
                    Remove section
                  </Button>
                </section>
              ))}
            </>
          )}
          {content.kind === "glossary" &&
            content.terms.map((term, index) => (
              <section
                key={term.id}
                className="space-y-3 rounded-xl border p-4"
              >
                <Input
                  aria-label="Proposed term"
                  value={term.term}
                  onChange={(e) =>
                    setContent({
                      ...content,
                      terms: content.terms.map((t, i) =>
                        i === index ? { ...t, term: e.target.value } : t
                      ),
                    })
                  }
                />
                {term.senses.map((sense, senseIndex) => (
                  <Textarea
                    key={sense.id}
                    aria-label="Proposed meaning"
                    value={sense.description}
                    onChange={(e) =>
                      setContent({
                        ...content,
                        terms: content.terms.map((t, i) =>
                          i === index
                            ? {
                                ...t,
                                senses: t.senses.map((s, j) =>
                                  j === senseIndex
                                    ? { ...s, description: e.target.value }
                                    : s
                                ),
                              }
                            : t
                        ),
                      })
                    }
                  />
                ))}
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() =>
                    setContent({
                      ...content,
                      terms: content.terms.filter((_, i) => i !== index),
                    })
                  }
                >
                  Remove term
                </Button>
              </section>
            ))}
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Keep pending
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void answer(false)}
          >
            Reject
          </Button>
          <Button disabled={busy} onClick={() => void answer(true)}>
            Accept edited proposal
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
