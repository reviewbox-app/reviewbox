import type { editor, IRange } from "monaco-editor"
import type { CodeBlock, CodeSide } from "../contracts/blockDiff.types"

export function codeBlocks(
  changes: editor.ILineChange[],
  sources?: { before: string; after: string }
): CodeBlock[] {
  const lines = sources && {
    before: sources.before.split(/\r?\n/),
    after: sources.after.split(/\r?\n/),
  }
  return changes.map((change, index) => {
    const before =
      change.originalEndLineNumber > 0
        ? {
            start: change.originalStartLineNumber,
            end: change.originalEndLineNumber,
          }
        : null
    const after =
      change.modifiedEndLineNumber > 0
        ? {
            start: change.modifiedStartLineNumber,
            end: change.modifiedEndLineNumber,
          }
        : null
    return {
      id: `${index}:${before?.start ?? 0}:${after?.start ?? 0}`,
      before,
      after,
      anchor: after ? after.start - 1 : change.modifiedStartLineNumber,
      words:
        lines && before && after
          ? {
              before: wordRanges(
                lines.before,
                (change.charChanges ?? []).map((c) => ({
                  startLineNumber: c.originalStartLineNumber,
                  endLineNumber: c.originalEndLineNumber,
                  startColumn: c.originalStartColumn,
                  endColumn: c.originalEndColumn,
                }))
              ),
              after: wordRanges(
                lines.after,
                (change.charChanges ?? []).map((c) => ({
                  startLineNumber: c.modifiedStartLineNumber,
                  endLineNumber: c.modifiedEndLineNumber,
                  startColumn: c.modifiedStartColumn,
                  endColumn: c.modifiedEndColumn,
                }))
              ),
            }
          : undefined,
    }
  })
}

export function containingBlock(
  blocks: CodeBlock[],
  side: CodeSide,
  line: number
) {
  return blocks.find((block) => {
    const range = block[side]
    return range && line >= range.start && line <= range.end
  })
}

/** Map unchanged lines only; changed lines must be revealed in their exact block. */
export function currentLine(blocks: CodeBlock[], oldLine: number): number {
  let delta = 0
  for (const block of blocks) {
    if (block.before && oldLine <= block.before.end) break
    const oldEnd = block.before?.end ?? 0
    // Insertions have no old range: derive their old boundary from prior deltas.
    if (!block.before && block.anchor - delta >= oldLine) break
    if (oldEnd < oldLine)
      delta +=
        (block.after ? block.after.end - block.after.start + 1 : 0) -
        (block.before ? block.before.end - block.before.start + 1 : 0)
  }
  return Math.max(1, oldLine + delta)
}

/** Expand worker-produced differences to words without marking whitespace alone. */
export function wordRanges(lines: string[], changes: IRange[]): IRange[] {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "word" })
  const byLine = new Map<number, { start: number; end: number }[]>()
  for (const change of changes) {
    for (
      let line = Math.max(1, change.startLineNumber);
      line <= Math.min(lines.length, change.endLineNumber);
      line++
    ) {
      const text = lines[line - 1]
      const start = line === change.startLineNumber ? change.startColumn - 1 : 0
      const end =
        line === change.endLineNumber ? change.endColumn - 1 : text.length
      if (end <= start || !text.slice(start, end).trim()) continue
      const ranges = byLine.get(line) ?? []
      for (const part of segmenter.segment(text)) {
        const last = part.index + part.segment.length
        if (part.index < end && last > start && part.segment.trim())
          ranges.push({ start: part.index, end: last })
      }
      byLine.set(line, ranges)
    }
  }
  return [...byLine]
    .sort(([a], [b]) => a - b)
    .flatMap(([line, ranges]) => {
      const merged: { start: number; end: number }[] = []
      for (const range of ranges.sort((a, b) => a.start - b.start)) {
        const previous = merged.at(-1)
        if (
          previous &&
          (range.start <= previous.end ||
            lines[line - 1].slice(previous.end, range.start) === " ")
        )
          previous.end = Math.max(previous.end, range.end)
        else merged.push({ ...range })
      }
      return merged.map((range) => ({
        startLineNumber: line,
        endLineNumber: line,
        startColumn: range.start + 1,
        endColumn: range.end + 1,
      }))
    })
}
