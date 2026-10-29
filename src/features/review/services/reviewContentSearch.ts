import type {
  Change,
  EditorSearchMatch,
  EditorSearchResult,
  FileContent,
} from "@/lib/desktop/contracts.generated"
export type ReviewSearchMatch = EditorSearchMatch & {
  changeId: string
  side: "before" | "after"
}
export type ReviewSearchResult = Omit<EditorSearchResult, "matches"> & {
  matches: ReviewSearchMatch[]
}

/** Bounded captured-source search, independent of the live filesystem and editor buffers. */
export async function searchReviewContent(
  changes: Change[],
  query: string,
  requestId: string,
  signal: AbortSignal,
  read: (changeId: string) => Promise<FileContent>,
  publish: (result: ReviewSearchResult) => void
): Promise<ReviewSearchResult> {
  const result: ReviewSearchResult = {
    requestId,
    matches: [],
    truncated: false,
    cancelled: false,
    scannedFiles: 0,
    skippedFiles: 0,
  }
  if (!query.trim()) return result
  const pattern = new RegExp(
    query.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "giu"
  )
  for (const change of changes) {
    if (signal.aborted) return { ...result, cancelled: true }
    if (result.scannedFiles >= 2000 || result.matches.length >= 1000) {
      result.truncated = true
      break
    }
    if (
      change.binary ||
      (change.before?.size ?? 0) + (change.after?.size ?? 0) > 4_000_000
    ) {
      result.skippedFiles++
      continue
    }
    const content = await read(change.id)
    if (signal.aborted) return { ...result, cancelled: true }
    result.scannedFiles++
    if (content.unavailableReason) {
      result.skippedFiles++
      continue
    }
    for (const side of ["after", "before"] as const) {
      const text = content[side]
      if (text === null || (side === "before" && text === content.after))
        continue
      if (text.length > 2_000_000) {
        result.skippedFiles++
        continue
      }
      let line = 0
      for (const value of text.split(/\r?\n/)) {
        line++
        pattern.lastIndex = 0
        for (let hit = pattern.exec(value); hit; hit = pattern.exec(value)) {
          if (result.matches.length >= 1000) {
            result.truncated = true
            break
          }
          const start = Math.max(0, hit.index - 80)
          result.matches.push({
            path: change.path,
            changeId: change.id,
            side,
            line,
            column: hit.index + 1,
            length: hit[0].length,
            preview: value.slice(start, hit.index + hit[0].length + 160),
            previewColumn: hit.index - start + 1,
          })
        }
        if (result.truncated) break
      }
      if (result.truncated) break
    }
    publish({ ...result, matches: [...result.matches] })
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return result
}
