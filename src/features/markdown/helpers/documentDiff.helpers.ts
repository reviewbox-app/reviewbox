import { diffArrays, diffLines } from "diff"
import type { Element, Nodes, Root, RootContent } from "hast"
import rehypeRaw from "rehype-raw"
import rehypeSanitize, { defaultSchema } from "rehype-sanitize"
import remarkBreaks from "remark-breaks"
import remarkGfm from "remark-gfm"
import remarkParse from "remark-parse"
import remarkRehype from "remark-rehype"
import { unified } from "unified"
import type {
  DocumentBlock,
  DocumentDiff,
  DocumentDiffRequest,
  DocumentDiffRow,
  TextRange,
} from "../contracts/documentDiff.types"

// Parse each complete document: reference definitions, nested lists and footnotes
// must resolve before blocks are compared or rendered independently.
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkBreaks)
  .use(remarkRehype, { allowDangerousHtml: true, clobberPrefix: "" })
  .use(rehypeRaw)
  .use(rehypeSanitize, { ...defaultSchema, clobberPrefix: "" })

const textBoundaries = new Set([
  "p",
  "li",
  "td",
  "th",
  "tr",
  "pre",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
])
function endsTextUnit(node: Nodes) {
  return node.type === "element" && textBoundaries.has(node.tagName)
}

export function nodeText(node: Nodes): string {
  if (node.type === "text") return node.value
  if (node.type === "element" && node.tagName === "br") return "\n"
  return "children" in node
    ? node.children.map(nodeText).join("") + (endsTextUnit(node) ? "\n" : "")
    : ""
}

function structure(node: Nodes): unknown {
  if (node.type === "text") return node.value
  if (node.type === "element")
    return [node.tagName, node.properties, node.children.map(structure)]
  return "children" in node ? node.children.map(structure) : node.type
}

function blocks(source: string | null): DocumentBlock[] {
  if (source === null) return []
  const parsed = processor.parse(source)
  const tree = processor.runSync(parsed) as Root
  return tree.children
    .filter((node) => node.type !== "text" || node.value.trim())
    .map((node) => {
      const position = node.position
      const raw = position
        ? source.slice(position.start.offset, position.end.offset)
        : ""
      return {
        tree: { type: "root", children: [node] },
        lines: {
          start: position?.start.line ?? 1,
          end: position?.end.line ?? source.split("\n").length,
        },
        text: nodeText(node),
        source: raw,
        signature: JSON.stringify([raw, structure(node)]),
      }
    })
}

function readableRanges(text: string, ranges: TextRange[]): TextRange[] {
  const result: TextRange[] = []
  for (const range of ranges) {
    // Indentation, line breaks and spacing-only edits do not need inline marks.
    for (const part of text.slice(range.start, range.end).matchAll(/\S+/gu)) {
      const start = range.start + part.index
      const end = start + part[0].length
      const previous = result.at(-1)
      const gap = previous && text.slice(previous.end, start)
      // Adjacent changed words form one phrase, including their single space.
      // Multiple spaces and tabs stay outside the highlight.
      if (previous && (gap === "" || gap === " ")) previous.end = end
      else result.push({ start, end })
    }
  }
  return result
}

/** Keep whole words readable while preserving UTF-16 offsets for DOM ranges. */
export function changedText(before: string, after: string) {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "word" })
  const parts = (text: string) =>
    Array.from(segmenter.segment(text), (part) => part.segment)
  const changes = diffArrays(parts(before), parts(after), { timeout: 150 })
  const removed: TextRange[] = []
  const added: TextRange[] = []
  if (!changes)
    return {
      removed: readableRanges(before, [{ start: 0, end: before.length }]),
      added: readableRanges(after, [{ start: 0, end: after.length }]),
    }
  let oldOffset = 0
  let newOffset = 0
  for (const change of changes) {
    const length = change.value.join("").length
    if (change.removed)
      removed.push({ start: oldOffset, end: oldOffset + length })
    if (change.added) added.push({ start: newOffset, end: newOffset + length })
    if (!change.added) oldOffset += length
    if (!change.removed) newOffset += length
  }
  return {
    removed: readableRanges(before, removed),
    added: readableRanges(after, added),
  }
}

function highlight(tree: Root, ranges: TextRange[]): Root {
  let offset = 0
  function visit(node: RootContent): RootContent[] {
    if (node.type === "element" && node.tagName === "br") offset++
    if (node.type === "text") {
      const start = offset
      offset += node.value.length
      // Structural whitespace in lists/tables must remain text, never an
      // invalid <mark> child of <ul>, <tr>, etc.
      if (!node.value.trim()) return [node]
      const pieces: RootContent[] = []
      let cursor = 0
      for (const range of ranges) {
        const from = Math.max(0, range.start - start)
        const to = Math.min(node.value.length, range.end - start)
        if (from >= to) continue
        if (from > cursor)
          pieces.push({ type: "text", value: node.value.slice(cursor, from) })
        pieces.push({
          type: "element",
          tagName: "mark",
          properties: { className: ["document-diff-text"] },
          children: [{ type: "text", value: node.value.slice(from, to) }],
        })
        cursor = to
      }
      if (cursor < node.value.length)
        pieces.push({ type: "text", value: node.value.slice(cursor) })
      return pieces
    }
    if (node.type === "element") {
      const children = node.children.flatMap(visit) as Element["children"]
      // Match the virtual boundaries used by nodeText: adjacent table cells
      // are separate words even though their HAST text nodes have no spaces.
      if (endsTextUnit(node)) offset++
      return [{ ...node, children }]
    }
    return [node]
  }
  return { ...tree, children: tree.children.flatMap(visit) }
}

function row(before?: DocumentBlock, after?: DocumentBlock): DocumentDiffRow {
  if (before?.signature === after?.signature)
    return { before, after, changed: false }
  // A wholly added or removed block is already identified by its background.
  // Inline marks only describe changes within a pair of existing blocks.
  if (!before || !after) return { before, after, changed: true }
  const ranges = changedText(before.text, after.text)
  const sameText = before && after && before.text === after.text
  return {
    before: before && {
      ...before,
      tree: highlight(before.tree, ranges.removed),
    },
    after: after && { ...after, tree: highlight(after.tree, ranges.added) },
    changed: true,
    detail: sameText ? "Formatting, link or image changed" : undefined,
  }
}

function pairBlocks(
  before: DocumentBlock[],
  after: DocumentBlock[]
): DocumentDiffRow[] {
  const ordered = () =>
    Array.from({ length: Math.max(before.length, after.length) }, (_, index) =>
      row(before[index], after[index])
    )
  // Bound alignment work for very large replacement runs. Parsing and the
  // initial exact-block diff still preserve every captured block in this case.
  if (!before.length || !after.length || before.length * after.length > 20_000)
    return ordered()
  const segmenter = new Intl.Segmenter(undefined, { granularity: "word" })
  const describe = (block: DocumentBlock) => {
    const words = new Map<string, number>()
    let count = 0
    for (const part of segmenter.segment(block.text)) {
      if (!part.isWordLike) continue
      const word = part.segment.toLocaleLowerCase()
      words.set(word, (words.get(word) ?? 0) + 1)
      count++
    }
    const first = block.tree.children[0]
    return {
      words,
      count,
      kind: first?.type === "element" ? first.tagName : first?.type,
    }
  }
  const previous = before.map(describe)
  const current = after.map(describe)
  const costs = Array.from(
    { length: before.length + 1 },
    () => new Float64Array(after.length + 1)
  )
  const choices = Array.from(
    { length: before.length + 1 },
    () => new Uint8Array(after.length + 1)
  )
  for (let i = 0; i <= before.length; i++) costs[i][0] = i
  for (let j = 0; j <= after.length; j++) costs[0][j] = j
  // Match similar blocks before computing their word changes. Simply pairing by
  // index shifts every following replacement when a new paragraph is inserted.
  for (let i = 1; i <= before.length; i++) {
    const old = previous[i - 1]
    for (let j = 1; j <= after.length; j++) {
      const next = current[j - 1]
      let common = 0
      for (const [word, count] of old.words)
        common += Math.min(count, next.words.get(word) ?? 0)
      const similarity =
        old.count + next.count ? (2 * common) / (old.count + next.count) : 0
      const replacement =
        costs[i - 1][j - 1] +
        (old.kind === next.kind ? 1.6 : 2.2) -
        1.5 * similarity
      const removal = costs[i - 1][j] + 1
      const addition = costs[i][j - 1] + 1
      costs[i][j] = Math.min(replacement, removal, addition)
      choices[i][j] =
        replacement <= removal && replacement <= addition
          ? 0
          : removal <= addition
            ? 1
            : 2
    }
  }
  const result: DocumentDiffRow[] = []
  let i = before.length,
    j = after.length
  while (i || j) {
    if (i && j && choices[i][j] === 0) result.push(row(before[--i], after[--j]))
    else if (i && (!j || choices[i][j] === 1)) result.push(row(before[--i]))
    else result.push(row(undefined, after[--j]))
  }
  return result.reverse()
}

export function compareDocuments({
  before,
  after,
}: DocumentDiffRequest): DocumentDiff {
  const previous = blocks(before)
  const current = blocks(after)
  const parts = diffArrays(previous, current, {
    comparator: (a, b) => a.signature === b.signature,
    timeout: 500,
  }) ?? [
    { removed: true, added: false, value: previous },
    { added: true, removed: false, value: current },
  ]
  const rows: DocumentDiffRow[] = []
  let removed: DocumentBlock[] = []
  let added: DocumentBlock[] = []
  const flush = () => {
    rows.push(...pairBlocks(removed, added))
    removed = []
    added = []
  }
  for (const part of parts) {
    if (part.removed) removed.push(...part.value)
    else if (part.added) added.push(...part.value)
    else {
      flush()
      // Equal blocks can have different line numbers after an earlier edit.
      for (const block of part.value)
        rows.push({ after: block, changed: false })
    }
  }
  flush()
  // Recover each unchanged block's original source coordinates without matching
  // by content again (repeated identical paragraphs are common).
  let oldIndex = 0
  for (const item of rows) {
    if (!item.changed) item.before = previous[oldIndex++]
    else if (item.before) oldIndex++
  }
  const lines = diffLines(before ?? "", after ?? "", { timeout: 500 })
  return {
    rows,
    added:
      lines?.reduce((n, part) => n + (part.added ? part.count : 0), 0) ??
      after?.split("\n").length ??
      0,
    removed:
      lines?.reduce((n, part) => n + (part.removed ? part.count : 0), 0) ??
      before?.split("\n").length ??
      0,
  }
}
