import type {
  LanguageRange,
  LanguageTokens,
} from "@/lib/desktop/contracts.generated"

export const semanticTokenTypes = [
  "namespace",
  "type",
  "class",
  "enum",
  "interface",
  "struct",
  "typeParameter",
  "parameter",
  "variable",
  "property",
  "enumMember",
  "event",
  "function",
  "method",
  "macro",
  "keyword",
  "modifier",
  "comment",
  "string",
  "number",
  "regexp",
  "operator",
  "decorator",
]
export const semanticTokenModifiers = [
  "declaration",
  "definition",
  "readonly",
  "static",
  "deprecated",
  "abstract",
  "async",
  "modification",
  "documentation",
  "defaultLibrary",
]

/** Server legends differ. Re-encode positions after dropping unsupported tokens. */
export function remapSemanticTokens(
  tokens: LanguageTokens,
  lineLengths: readonly number[]
) {
  if (tokens.data.length % 5) return new Uint32Array()
  const data: number[] = []
  let line = 0
  let column = 0
  let previousLine = 0
  let previousColumn = 0
  for (let index = 0; index < tokens.data.length; index += 5) {
    const [deltaLine, deltaColumn, length, typeIndex, modifiers] =
      tokens.data.slice(index, index + 5)
    if (
      ![deltaLine, deltaColumn, length, typeIndex, modifiers].every(
        (value) => Number.isSafeInteger(value) && value >= 0
      )
    )
      return new Uint32Array()
    line += deltaLine
    column = deltaLine ? deltaColumn : column + deltaColumn
    const type = semanticTokenTypes.indexOf(tokens.tokenTypes[typeIndex])
    if (
      type < 0 ||
      !length ||
      line >= lineLengths.length ||
      column + length > lineLengths[line]
    )
      continue
    let flags = 0
    for (let bit = 0; bit < Math.min(32, tokens.tokenModifiers.length); bit++) {
      if ((modifiers >>> bit) & 1) {
        const normalized = semanticTokenModifiers.indexOf(
          tokens.tokenModifiers[bit]
        )
        if (normalized >= 0) flags |= 1 << normalized
      }
    }
    data.push(
      line - previousLine,
      line === previousLine ? column - previousColumn : column,
      length,
      type,
      flags
    )
    previousLine = line
    previousColumn = column
  }
  return new Uint32Array(data)
}

export function monacoRange(range: LanguageRange) {
  return {
    startLineNumber: range.startLine,
    startColumn: range.startColumn,
    endLineNumber: range.endLine,
    endColumn: range.endColumn,
  }
}
