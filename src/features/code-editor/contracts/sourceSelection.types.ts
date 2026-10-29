export type SourceSelection = {
  side: "before" | "after"
  range: {
    startLine: number
    startColumn: number
    endLine: number
    endColumn: number
  }
  excerpt: string
  position: { left: number; top: number; bottom: number }
}

export type SourceSearchTarget = {
  path: string
  side: "before" | "after"
  line: number
  column: number
  length: number
  token: string
}
