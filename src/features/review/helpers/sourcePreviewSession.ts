import type { editor } from "monaco-editor"
import type { SourceReadingPoint } from "@/features/markdown/contracts/documentDiff.types"

export type SourceMode = "markdown" | "code"
export type SourceViewPosition = {
  point: SourceReadingPoint
  split: boolean
  scrollTop?: number
  code?: editor.IDiffEditorViewState | null
}
export type SourceViewHandle = {
  find: () => void
  capture: () => SourceViewPosition | undefined
}
export type SourcePreviewSession = {
  mode?: SourceMode
  point?: SourceReadingPoint
  markdown?: SourceViewPosition
  code?: SourceViewPosition
}

// Session-only view state of immutable captures, separate from durable decisions.
const sessions = new Map<string, SourcePreviewSession>()
export function sourcePreviewSession(key: string): SourcePreviewSession {
  return sessions.get(key) ?? {}
}
export function updateSourcePreviewSession(
  key: string,
  update: Partial<SourcePreviewSession>
) {
  sessions.set(key, { ...sessions.get(key), ...update })
}
