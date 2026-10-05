import { resolveLanguageId } from "@/lib/code/languages"

export const LANGUAGE_DETECTION_LIMIT = 100_000
export interface LanguageCandidate {
  languageId: string
  confidence: number
}
export interface ContentLanguageDetection {
  path: string
  version: number
  languageId?: string
  candidates: LanguageCandidate[]
  error?: string
}

/** An uncertain result is a suggestion, not a reason to change editor behavior. */
export function languagePrediction(results: readonly LanguageCandidate[]) {
  const candidates = new Map<string, number>()
  for (const result of results) {
    const languageId = resolveLanguageId(result.languageId).id
    if (
      languageId === "plaintext" ||
      !Number.isFinite(result.confidence) ||
      result.confidence < 0 ||
      result.confidence > 1
    )
      continue
    candidates.set(
      languageId,
      Math.max(candidates.get(languageId) ?? 0, result.confidence)
    )
  }
  const ranked = [...candidates]
    .map(([languageId, confidence]) => ({
      languageId,
      confidence,
    }))
    .sort((a, b) => b.confidence - a.confidence)
  const first = ranked[0]
  const competitor = Math.max(
    0,
    ...results
      .filter(
        (result) =>
          Number.isFinite(result.confidence) &&
          resolveLanguageId(result.languageId).id !== first?.languageId
      )
      .map((result) => result.confidence)
  )
  return {
    languageId:
      first && first.confidence >= 0.65 && first.confidence - competitor >= 0.15
        ? first.languageId
        : undefined,
    candidates: ranked.slice(0, 3),
  }
}
