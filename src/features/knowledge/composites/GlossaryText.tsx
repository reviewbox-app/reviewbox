"use client"
import {
  HoverCard,
  HoverCardTrigger,
  HoverCardContent,
} from "@/components/ui/hover-card"
import type {
  GlossaryTerm,
  TermOccurrence,
} from "@/lib/desktop/contracts.generated"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { matchGlossary } from "../helpers/glossary.helpers"
export function GlossaryText({
  text,
  terms,
  occurrences,
  sectionId,
}: {
  text: string
  terms: GlossaryTerm[]
  occurrences: TermOccurrence[]
  sectionId: string
}) {
  const matches = matchGlossary(text, terms, occurrences, sectionId)
  const chars = Array.from(text)
  const nodes = matches.map((match, matchIndex) => {
    const prefix = chars
      .slice(matches[matchIndex - 1]?.end ?? 0, match.start)
      .join("")
    return (
      <span key={match.start}>
        {prefix}
        <HoverCard>
          <HoverCardTrigger
            render={<button type="button" />}
            className={cn(
              "cursor-help rounded-sm border-b border-dotted focus-visible:outline-2 focus-visible:outline-primary",
              match.ambiguous
                ? "border-review-attention text-review-attention"
                : "border-primary text-primary"
            )}
            title={
              match.ambiguous
                ? "Multiple meanings — choose in glossary"
                : match.descriptions[0]
            }
          >
            {match.text}
          </HoverCardTrigger>
          <HoverCardContent className="w-80 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h4 className="font-medium">{match.text}</h4>
              {match.ambiguous && <Badge variant="secondary">Ambiguous</Badge>}
            </div>
            <ol className="space-y-1.5">
              {match.descriptions.map((description, index) => (
                <li
                  key={index}
                  className="flex gap-2.5 rounded-2xl border p-2.5 text-sm leading-5"
                >
                  {match.descriptions.length > 1 && (
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs text-muted-foreground">
                      {index + 1}
                    </span>
                  )}
                  {description}
                </li>
              ))}
            </ol>
            {match.ambiguous && (
              <p className="text-xs text-review-attention">
                No meaning is selected automatically. Choose one for this
                occurrence with “Explain a word”.
              </p>
            )}
          </HoverCardContent>
        </HoverCard>
      </span>
    )
  })
  return (
    <p className="text-sm leading-6 whitespace-pre-wrap">
      {nodes}
      {chars.slice(matches.at(-1)?.end ?? 0).join("")}
    </p>
  )
}
