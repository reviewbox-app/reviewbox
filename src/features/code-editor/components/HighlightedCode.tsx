"use client"

import {
  Fragment,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import { useTheme } from "next-themes"
import type { ThemedToken } from "shiki"
import { useCodeTheme } from "@/lib/code/codeAppearance"
import {
  highlightCode,
  subscribeShaderSyntax,
  getShaderSyntax,
} from "@/lib/code/highlighter"
import { resolveLanguageId } from "@/lib/code/languages"
import { tokenizePseudocode } from "@/lib/code/pseudocode"
import { pseudoPalette } from "@/lib/code/themes"

export type CodeHighlight = { start: number; end: number }

function markedText(
  text: string,
  offset: number,
  ranges: CodeHighlight[]
): ReactNode {
  if (!ranges.length) return text
  const result: ReactNode[] = []
  let cursor = 0
  for (const range of ranges) {
    const start = Math.max(0, range.start - offset)
    const end = Math.min(text.length, range.end - offset)
    if (start >= end) continue
    result.push(text.slice(cursor, start))
    result.push(
      <mark key={start} className="document-diff-text">
        {text.slice(start, end)}
      </mark>
    )
    cursor = end
  }
  result.push(text.slice(cursor))
  return result
}

function withOffsets<T>(lines: T[][], text: (token: T) => string) {
  let offset = 0
  return lines.map((line) => {
    const tokens = line.map((token) => {
      const entry = { token, offset }
      offset += text(token).length
      return entry
    })
    offset++
    return tokens
  })
}

/** Static snippets share Monaco's tokenizer and theme, without mounting an editor. */
export function HighlightedCode({
  source,
  language,
  highlights = [],
}: {
  source: string
  language?: string
  highlights?: CodeHighlight[]
}) {
  const { resolvedTheme } = useTheme()
  const theme = useCodeTheme(resolvedTheme !== "light")
  const id = resolveLanguageId(language).id
  const shaderSyntax = useSyncExternalStore(
    subscribeShaderSyntax,
    getShaderSyntax,
    () => true
  )
  const key = `${theme}\0${id}\0${shaderSyntax}\0${source}`
  const [highlighted, setHighlighted] = useState<{
    key: string
    lines: ThemedToken[][]
  } | null>(null)
  const pseudo = useMemo(
    () => (id === "reviewbox-pseudocode" ? tokenizePseudocode(source) : null),
    [id, source]
  )
  useEffect(() => {
    if (pseudo || id === "plaintext") return
    let active = true
    void highlightCode(source, id, theme)
      .then((lines) => {
        if (active) setHighlighted({ key, lines })
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [key, source, id, theme, pseudo])
  if (pseudo) {
    const palette = pseudoPalette(theme)
    return (
      <code data-language={id}>
        {withOffsets(pseudo, (token) => token.text).map((line, i) => (
          <Fragment key={i}>
            {i > 0 && "\n"}
            {line.map(({ token, offset }) => (
              <span
                key={token.start}
                data-token={token.kind}
                style={{
                  color: palette[token.kind],
                  fontStyle: token.kind === "comment" ? "italic" : undefined,
                }}
              >
                {markedText(token.text, offset, highlights)}
              </span>
            ))}
          </Fragment>
        ))}
      </code>
    )
  }
  if (highlighted?.key !== key)
    return <code data-language={id}>{markedText(source, 0, highlights)}</code>
  return (
    <code data-language={id}>
      {withOffsets(highlighted.lines, (token) => token.content).map(
        (line, i) => (
          <Fragment key={i}>
            {i > 0 && "\n"}
            {line.map(({ token, offset }, j) => (
              <span
                key={j}
                style={{
                  color: token.color,
                  fontStyle: (token.fontStyle ?? 0) & 1 ? "italic" : undefined,
                  fontWeight: (token.fontStyle ?? 0) & 2 ? 700 : undefined,
                  textDecoration:
                    (token.fontStyle ?? 0) & 4 ? "underline" : undefined,
                }}
              >
                {markedText(token.content, offset, highlights)}
              </span>
            ))}
          </Fragment>
        )
      )}
    </code>
  )
}
