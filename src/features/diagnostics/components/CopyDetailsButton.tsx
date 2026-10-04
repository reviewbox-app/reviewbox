"use client"

import { useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"

export function CopyDetailsButton({
  text,
  label = "Copy error details",
  disabled = false,
}: {
  text: string
  label?: string
  disabled?: boolean
}) {
  const [copied, setCopied] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(text)
      setFailed(null)
    } catch {
      setCopied(null)
      setFailed(text)
    }
  }
  return (
    <div className="min-w-0">
      <Button variant="ghost" size="sm" onClick={copy} disabled={disabled}>
        <HugeiconsIcon
          icon={copied === text ? Tick02Icon : Copy01Icon}
          size={14}
        />
        {copied === text ? "Copied" : label}
      </Button>
      <span role="status" className="sr-only">
        {copied === text ? "Error details copied" : ""}
      </span>
      {failed === text && (
        <div className="mt-2 space-y-2">
          <p role="alert" className="text-xs text-destructive">
            Copy failed. Select the details below to copy them manually.
          </p>
          <pre
            tabIndex={0}
            className="max-h-60 overflow-auto rounded-xl bg-muted p-3 text-xs wrap-anywhere whitespace-pre-wrap select-text"
          >
            {text}
          </pre>
        </div>
      )}
    </div>
  )
}
