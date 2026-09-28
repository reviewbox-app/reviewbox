import type {
  Change,
  FileContent,
  Passage,
  PseudoTranslation,
  ReviewFileContent,
} from "@/lib/desktop/contracts.generated"

export type PseudoContent = FileContent & { skipReason?: string }

export function translatedSide(
  translation: PseudoTranslation | undefined,
  present: boolean
) {
  if (!present) return { text: "", unavailableReason: null }
  if (!translation || translation.unavailableReason)
    return {
      text: "",
      unavailableReason:
        translation?.unavailableReason ||
        "Pseudocode is unavailable for this version of the file.",
    }
  return {
    text: translation.blocks.map((block) => block.text).join("\n"),
    unavailableReason: null,
  }
}

export function pseudoDiff(
  change: Change,
  file: ReviewFileContent | null
): PseudoContent {
  if (!file)
    return {
      before: null,
      after: null,
      unavailableReason: "Loading pseudocode…",
    }
  if (file.pseudocodeSelected === false || file.pseudocodeSkipReason)
    return {
      before: null,
      after: null,
      unavailableReason: null,
      skipReason: "Pseudo-code is not available for this file.",
    }
  const before = translatedSide(
    file.translations.find(
      (item) => item.sourceId === `change:${change.id}:before`
    ),
    !!change.before
  )
  const after = translatedSide(
    file.translations.find(
      (item) => item.sourceId === `change:${change.id}:after`
    ),
    !!change.after
  )
  return {
    before: before.text,
    after: after.text,
    unavailableReason: before.unavailableReason || after.unavailableReason,
  }
}

/** Source line ranges and translated line ranges have different coordinates. */
function translatedRange(
  translation: PseudoTranslation | undefined,
  start: number,
  length: number
) {
  if (!translation || !length) return { start: 0, length: 0 }
  let line = 1
  let first = 0
  let last = 0
  for (const block of translation.blocks) {
    const lines = block.text.split("\n").length
    if (block.startLine < start + length && block.endLine >= start) {
      if (!first) first = line
      last = line + lines - 1
    }
    line += lines
  }
  return { start: first, length: first ? last - first + 1 : 0 }
}
export function pseudoPassage(
  change: Change,
  passage: Passage | undefined,
  file: ReviewFileContent | null
): Passage | undefined {
  if (!passage || !file) return undefined
  const before = translatedRange(
    file.translations.find(
      (item) => item.sourceId === `change:${change.id}:before`
    ),
    passage.oldStart,
    passage.oldLines
  )
  const after = translatedRange(
    file.translations.find(
      (item) => item.sourceId === `change:${change.id}:after`
    ),
    passage.newStart,
    passage.newLines
  )
  if (!before.length && !after.length) return undefined
  return {
    ...passage,
    oldStart: before.start,
    oldLines: before.length,
    newStart: after.start,
    newLines: after.length,
  }
}

/** The shared display lexer is used by Monaco, documents and reference cards. */
export { registerPseudoLanguage as registerPseudocode } from "@/lib/code/highlighter"
