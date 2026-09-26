import type {
  GlossaryTerm,
  TermOccurrence,
} from "@/lib/desktop/contracts.generated"
export interface GlossaryMatch {
  start: number
  end: number
  text: string
  descriptions: string[]
  ambiguous: boolean
}
const word = (value: string | undefined) =>
  !!value && /[\p{L}\p{N}_]/u.test(value)
export function matchGlossary(
  text: string,
  terms: GlossaryTerm[],
  occurrences: TermOccurrence[] = [],
  sectionId = ""
): GlossaryMatch[] {
  const matches: GlossaryMatch[] = []
  const characters = Array.from(text)
  for (let index = 0; index < characters.length;) {
    const tail = characters.slice(index).join("")
    const explicit = occurrences.find(
      (o) =>
        o.sectionId === sectionId &&
        o.offset === index &&
        tail.startsWith(o.quote)
    )
    if (explicit) {
      const linked = terms
        .find((t) => t.id === explicit.termId)
        ?.senses.find((s) => s.id === explicit.senseId)?.description
      const descriptions = [explicit.description ?? linked].filter(
        (s): s is string => !!s
      )
      if (descriptions.length) {
        const length = Array.from(explicit.quote).length
        matches.push({
          start: index,
          end: index + length,
          text: explicit.quote,
          descriptions,
          ambiguous: false,
        })
        index += length
        continue
      }
    }
    const candidates = terms
      .filter((t) => !t.archived)
      .flatMap((term) =>
        [term.term, ...term.aliases]
          .filter(Boolean)
          .map((alias) => ({ term, alias, length: Array.from(alias).length }))
      )
      .filter(
        ({ alias, length }) =>
          tail.toLocaleLowerCase().startsWith(alias.toLocaleLowerCase()) &&
          !word(characters[index - 1]) &&
          !word(characters[index + length])
      )
      .sort((a, b) => b.length - a.length)
    if (candidates.length) {
      const length = candidates[0].length
      const descriptions = [
        ...new Set(
          candidates
            .filter((c) => c.length === length)
            .flatMap((c) => c.term.senses.map((s) => s.description))
        ),
      ]
      matches.push({
        start: index,
        end: index + length,
        text: characters.slice(index, index + length).join(""),
        descriptions,
        ambiguous: descriptions.length !== 1,
      })
      index += length
    } else index++
  }
  return matches
}
