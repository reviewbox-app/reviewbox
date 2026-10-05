import {
  codeLanguages,
  detectCodeLanguage,
  type CodeLanguage,
  type LanguageDecision,
} from "@/lib/code/languages"
import type { EditorEntry } from "@/lib/desktop/contracts.generated"

type ProjectEntry = Pick<EditorEntry, "path" | "directory" | "ignored">
type DirectoryLanguages = Map<string, Set<string>>
const indexes = new WeakMap<
  readonly ProjectEntry[],
  { registry: readonly CodeLanguage[]; directories: DirectoryLanguages }
>()

function parent(path: string) {
  const separator = path.lastIndexOf("/")
  return separator < 0 ? "" : path.slice(0, separator)
}

/** Index only the already loaded inventory, once per snapshot and registry. */
function directoryLanguages(entries: readonly ProjectEntry[]) {
  const cached = indexes.get(entries)
  if (cached?.registry === codeLanguages) return cached.directories
  const directories: DirectoryLanguages = new Map()
  for (const entry of entries) {
    if (entry.directory || entry.ignored) continue
    const path = entry.path.replaceAll("\\", "/")
    const decision = detectCodeLanguage(path)
    if (decision.source === "plaintext") continue
    let directory = parent(path)
    for (;;) {
      let languages = directories.get(directory)
      if (!languages) directories.set(directory, (languages = new Set()))
      languages.add(decision.language.id)
      if (!directory) break
      directory = parent(directory)
    }
  }
  indexes.set(entries, { registry: codeLanguages, directories })
  return directories
}

/** Only ambiguous associations can use nearby unambiguous source files. */
export function detectProjectLanguage(
  path: string,
  firstLine: string | undefined,
  entries: readonly ProjectEntry[]
): LanguageDecision {
  const decision = detectCodeLanguage(path, firstLine)
  if (decision.source !== "plaintext" || decision.candidates.length < 2)
    return decision
  const directories = directoryLanguages(entries)
  let directory = parent(path.replaceAll("\\", "/"))
  for (;;) {
    const nearby = directories.get(directory)
    const candidates = decision.candidates.filter((language) =>
      nearby?.has(language.id)
    )
    if (candidates.length === 1)
      return { language: candidates[0], source: "project", candidates: [] }
    // A mixed nearest project must not inherit an arbitrary outer preference.
    if (candidates.length > 1 || !directory) return decision
    directory = parent(directory)
  }
}
