import type { Root } from "hast"

export type SourceSide = "before" | "after"
export type SourceRange = { start: number; end: number }
export type TextRange = { start: number; end: number }
export type DocumentBlock = {
  tree: Root
  lines: SourceRange
  text: string
  source: string
  signature: string
}
export type DocumentDiffRow = {
  before?: DocumentBlock
  after?: DocumentBlock
  changed: boolean
  /** A source/structure change remains visible even when the prose is identical. */
  detail?: string
}
export type DocumentDiff = {
  rows: DocumentDiffRow[]
  added: number
  removed: number
}
export type SourceReadingPoint = {
  side: SourceSide
  line: number
  /** Fraction through the source line, independent of rendered line height. */
  fraction: number
}
export type DocumentViewPosition = {
  point: SourceReadingPoint
  split: boolean
  scrollTop?: number
}
export type DocumentViewHandle = {
  find: () => void
  capture: () => DocumentViewPosition | undefined
}
export type DocumentDiffRequest = {
  before: string | null
  after: string | null
}
export type DocumentDiffResponse = { result: DocumentDiff } | { error: string }
