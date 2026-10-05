import type { Ref } from "react"
import type { editor, IRange } from "monaco-editor"
import type { LanguageDocument } from "@/lib/desktop/contracts.generated"
import type { SourceSelection } from "./sourceSelection.types"

export type CodeSide = "before" | "after"
export type CodePoint = { side: CodeSide; line: number; fraction: number }
export type CodeRange = { start: number; end: number }
export type CodeBlock = {
  id: string
  before: CodeRange | null
  after: CodeRange | null
  /** Last current line preceding the block, zero at the beginning of a file. */
  anchor: number
  words?: { before: IRange[]; after: IRange[] }
}
export type BlockDiffHandle = {
  find: () => void
  capture: () => CodePoint | undefined
  reveal: (point: CodePoint, end?: number) => void
}
export type BlockDiffProps = {
  onCommentSelection?: (selection: SourceSelection | null) => void
  before: string
  after: string
  language: string
  modelPath: string
  beforeDocument?: LanguageDocument
  afterDocument?: LanguageDocument
  compare: boolean
  onCompare: (value: boolean) => void
  trimWhitespace: boolean
  overlayTop: number
  bottom: number
  inset: number
  point?: CodePoint
  target?: { side: CodeSide; start: number; end: number; identity: unknown }
  onCapture: (point: CodePoint) => void
  onCounts: (counts: { added: number; removed: number }) => void
  onCursor: (position: { line: number; column: number }) => void
  handle: Ref<BlockDiffHandle>
}
export type BlockDiffModels = {
  before: editor.ITextModel
  after: editor.ITextModel
}
