"use client"

import { Fragment, useEffect, useMemo, useState } from "react"
import { useTheme } from "next-themes"
import type { ThemedToken } from "shiki"
import { useCodeTheme } from "@/lib/code/codeAppearance"
import { highlightCode } from "@/lib/code/highlighter"
import { resolveLanguageId } from "@/lib/code/languages"
import { tokenizePseudocode } from "@/lib/code/pseudocode"
import { pseudoPalette } from "@/lib/code/themes"

/** Static snippets share Monaco's tokenizer and theme, without mounting an editor. */
export function HighlightedCode({
  source,
  language,
}: {
  source: string
  language?: string
}) {
  const { resolvedTheme } = useTheme()
  const theme = useCodeTheme(resolvedTheme !== "light")
  const id = resolveLanguageId(language).id
  const key = `${theme}\0${id}\0${source}`
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
        {pseudo.map((line, i) => (
          <Fragment key={i}>
            {i > 0 && "\n"}
            {line.map((token) => (
              <span
                key={token.start}
                data-token={token.kind}
                style={{
                  color: palette[token.kind],
                  fontStyle: token.kind === "comment" ? "italic" : undefined,
                }}
              >
                {token.text}
              </span>
            ))}
          </Fragment>
        ))}
      </code>
    )
  }
  if (highlighted?.key !== key) return <code data-language={id}>{source}</code>
  return (
    <code data-language={id}>
      {highlighted.lines.map((line, i) => (
        <Fragment key={i}>
          {i > 0 && "\n"}
          {line.map((token, j) => (
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
              {token.content}
            </span>
          ))}
        </Fragment>
      ))}
    </code>
  )
}
