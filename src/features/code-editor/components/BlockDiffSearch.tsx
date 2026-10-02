"use client"
import { useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowUp01Icon,
  ArrowDown01Icon,
  Cancel01Icon,
} from "@hugeicons/core-free-icons"

export function BlockDiffSearch({
  query,
  onQuery,
  index,
  count,
  next,
  close,
}: {
  query: string
  onQuery: (value: string) => void
  index: number
  count: number
  next: (direction: number) => void
  close: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])
  return (
    <div
      className="block-search"
      role="search"
      aria-label="Find in captured code"
    >
      <Input
        ref={input}
        aria-label="Find in file"
        placeholder="Find"
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault()
            event.stopPropagation()
            close()
          }
          if (event.key === "Enter") {
            event.preventDefault()
            next(event.shiftKey ? -1 : 1)
          }
        }}
      />
      <span className="shrink-0 text-xs text-muted-foreground" role="status">
        {count ? `${index + 1}/${count}` : "0 results"}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Previous match"
        disabled={!count}
        onClick={() => next(-1)}
      >
        <HugeiconsIcon icon={ArrowUp01Icon} />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Next match"
        disabled={!count}
        onClick={() => next(1)}
      >
        <HugeiconsIcon icon={ArrowDown01Icon} />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Close search"
        onClick={close}
      >
        <HugeiconsIcon icon={Cancel01Icon} />
      </Button>
    </div>
  )
}
