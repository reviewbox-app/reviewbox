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
  return (
    [pseudo, ...codeLanguages].find(
      (language) =>
        language.id === value ||
        language.aliases?.includes(value ?? "") ||
        language.extensions.includes(value ?? "")
    ) ?? plaintext
  )
}

export function resolveCodeLanguage(
  path: string,
  firstLine?: string
): CodeLanguage {
  const name = path.replaceAll("\\", "/").split("/").at(-1) ?? ""
  const named = codeLanguages.find((language) =>
    language.filenames?.some((file) => matchesName(file, name))
  )
  if (named) return named
  const extension = name.includes(".")
    ? name.split(".").at(-1)?.toLowerCase()
    : ""
  const known = codeLanguages.find((language) =>
    language.extensions.includes(extension ?? "")
  )
  if (known) return known
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
    if (detected) return detected
  }
  return plaintext
}

/** File-name patterns deliberately support only *; no platform-specific glob semantics. */
function matchesName(pattern: string, name: string) {
  const expression = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*")
  return new RegExp(`^${expression}$`, "i").test(name)
}
