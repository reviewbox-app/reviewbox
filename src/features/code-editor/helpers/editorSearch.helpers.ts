import type { EditorEntry } from "@/lib/desktop/contracts.generated"

export function indexEditorFiles(
  entries: EditorEntry[],
  ignored: ReadonlySet<string>
) {
  return entries
    .filter((entry) => !entry.directory && !ignored.has(entry.path))
    .map((entry) => ({ path: entry.path, search: entry.path.toLowerCase() }))
}
export function findEditorFiles(
  index: ReturnType<typeof indexEditorFiles>,
  query: string,
  limit = 1000
) {
  const needle = query.trim().toLowerCase()
  const paths: string[] = []
  let truncated = false
  for (const item of index) {
    if (!item.search.includes(needle)) continue
    if (paths.length === limit) {
      truncated = true
      break
    }
    paths.push(item.path)
  }
  return { paths, truncated }
}
