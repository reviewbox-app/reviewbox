import { resolveCodeLanguage } from "@/lib/code/languages"

/** The current name wins on renames; a deleted file uses its captured old name. */
export function isDocumentFile(path: string, firstLine?: string): boolean {
  const language = resolveCodeLanguage(path, firstLine).id
  if (language !== "plaintext" && language !== "markdown") return false
  const name = path.replaceAll("\\", "/").split("/").at(-1) ?? ""
  if (/\.(?:mdx|adoc|asciidoc|rst|rest)$/i.test(name)) return false
  if (/\.(?:md|markdown|mdown|mkd|mkdn|txt|text)$/i.test(name)) return true
  return /^(?:readme|licen[cs]e|copying|notice|changelog|authors|contributors|todo)(?:[._-][a-z0-9][a-z0-9._-]*)?$/i.test(
    name
  )
}
