"use client"

import { useState, type ReactNode } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"

export function MarkdownCodeBlock({
  source,
  language,
  children,
}: {
  source: string
  language?: string
  children?: ReactNode
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
        <span>{language || "Code"}</span>
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
      <pre className="m-0 overflow-x-auto bg-transparent p-4 font-mono text-xs leading-5 text-foreground">
        {children ?? <code>{source}</code>}
      </pre>
    </div>
  )
}
