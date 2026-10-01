"use client"

import { useState } from "react"
import {
  HighlightedCode,
  type CodeHighlight,
} from "@/features/code-editor/components/HighlightedCode"
import { HugeiconsIcon } from "@hugeicons/react"
import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"

export function MarkdownCodeBlock({
  source,
  language,
  label,
  highlights,
}: {
  source: string
  language?: string
  label?: string
  highlights?: CodeHighlight[]
}) {
  const [copied, setCopied] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const isCopied = copied === source

  async function copy() {
    try {
      await navigator.clipboard.writeText(source)
      setCopied(source)
      setError(false)
    } catch {
      setError(true)
    }
  }

  return (
    <div className="markdown-code not-prose my-4 min-w-0 overflow-hidden rounded-xl border bg-muted">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-1 text-xs text-muted-foreground">
        <span>{label || language || "Code"}</span>
        <Button variant="ghost" size="xs" onClick={copy} aria-label="Copy code">
          <HugeiconsIcon icon={isCopied ? Tick02Icon : Copy01Icon} />
          {isCopied ? "Copied" : "Copy"}
        </Button>
        <span className="sr-only" role="status">
          {error
            ? "Copy failed. Select the code to copy it manually."
            : isCopied
              ? "Code copied"
              : ""}
        </span>
      </div>
      <pre className="m-0 bg-transparent p-4 font-mono text-xs leading-5 [overflow-wrap:anywhere] whitespace-pre-wrap text-foreground [&_code]:whitespace-pre-wrap">
        <HighlightedCode
          source={source}
          language={language}
          highlights={highlights}
        />
      </pre>
    </div>
  )
}
