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
            className="cursor-help rounded-sm border-b border-dotted border-primary text-primary focus-visible:outline-2 focus-visible:outline-primary"
            title={
              match.ambiguous
                ? "Multiple meanings — choose in glossary"
                : match.descriptions[0]
            }
          >
            {match.text}
          </HoverCardTrigger>
          <HoverCardContent className="space-y-3">
            <h4 className="font-medium">{match.text}</h4>
            {match.ambiguous && (
              <p className="text-xs text-review-attention">
                Multiple meanings. No meaning was selected automatically.
              </p>
            )}
            {match.descriptions.map((description, index) => (
              <p key={index} className="text-sm leading-6">
                {description}
              </p>
            ))}
          </HoverCardContent>
        </HoverCard>
      </span>
    )
  })
  return (
    <p className="text-sm leading-7 whitespace-pre-wrap">
      {nodes}
      {chars.slice(matches.at(-1)?.end ?? 0).join("")}
    </p>
  )
}
