export interface CodeLanguage {
  /** TextMate / Monaco identity, distinct from the language-server identity. */
  id: string
  name: string
  lspId: string
  extensions: readonly string[]
  filenames?: readonly string[]
  aliases?: readonly string[]
  interpreters?: readonly string[]
}

export type LanguageDetectionSource =
  | "manual"
  | "association"
  | "filename"
  | "extension"
  | "firstLine"
  | "project"
  | "content"
  | "plaintext"
export interface LanguageDecision {
  language: CodeLanguage
  source: LanguageDetectionSource
  /** Conflicting associations are candidates, never resolved by registry order. */
  candidates: readonly CodeLanguage[]
}

import bundledDefinitions from "../../../resources/languages/languages.json"

/** Native and webview resolve the same bundled and locally imported definitions. */
export let codeLanguages: readonly CodeLanguage[] = bundledDefinitions
export function configureCodeLanguages(languages: readonly CodeLanguage[]) {
  codeLanguages = languages
}

const plaintext: CodeLanguage = {
  id: "plaintext",
  name: "Plain text",
  lspId: "plaintext",
  extensions: [],
}
const pseudo: CodeLanguage = {
  id: "reviewbox-pseudocode",
  name: "Pseudo-code",
  lspId: "reviewbox-pseudocode",
  extensions: [],
  aliases: ["pseudo", "pseudocode", "pseudo-code"],
}

export function resolveLanguageId(id: string | undefined): CodeLanguage {
  const value = id?.toLowerCase()
  const languages = [plaintext, pseudo, ...codeLanguages]
  return (
    languages.find(
      (language) =>
        language.id === value ||
        language.lspId === value ||
        language.aliases?.some((alias) => alias.toLowerCase() === value)
    ) ??
    languages.find((language) => language.extensions.includes(value ?? "")) ??
    plaintext
  )
}

export function resolveCodeLanguage(
  path: string,
  firstLine?: string
): CodeLanguage {
  const decision = detectCodeLanguage(path, firstLine)
  // Captured/read-only readers have no live detection lifecycle. Preserve their
  // historical coloring (notably C++ headers); live editors use the decision API.
  if (decision.candidates.length) {
    if (path.toLowerCase().endsWith(".h"))
      return (
        decision.candidates.find((language) => language.id === "cpp") ??
        decision.candidates[0]
      )
    return decision.candidates[0]
  }
  return decision.language
}

export function detectCodeLanguage(
  path: string,
  firstLine?: string
): LanguageDecision {
  const name = path.replaceAll("\\", "/").split("/").at(-1) ?? ""
  const named = codeLanguages.find((language) =>
    language.filenames?.some((file) => matchesName(file, name))
  )
  if (named) return { language: named, source: "filename", candidates: [] }
  const extension = name.includes(".")
    ? name.split(".").at(-1)?.toLowerCase()
    : ""
  const known = codeLanguages.filter((language) =>
    language.extensions.includes(extension ?? "")
  )
  if (known.length === 1)
    return { language: known[0], source: "extension", candidates: [] }
  if (firstLine?.startsWith("#!")) {
    const words = firstLine
      .slice(2)
      .trim()
      .split(/\s+/)
      .map((word) => word.split("/").at(-1) ?? word)
    const detected = codeLanguages.find((language) =>
      language.interpreters?.some((pattern) =>
        words.some((word) => matchesName(pattern, word))
      )
    )
    if (detected)
      return { language: detected, source: "firstLine", candidates: [] }
  }
  return { language: plaintext, source: "plaintext", candidates: known }
}

/** File-name patterns deliberately support only *; no platform-specific glob semantics. */
function matchesName(pattern: string, name: string) {
  const expression = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*")
  return new RegExp(`^${expression}$`, "i").test(name)
}
