"use client"

import { useEffect, useId, useRef, useState, type RefObject } from "react"

/** DOM text includes rendered Markdown only, never destinations or Markdown syntax. */
export function useDocumentSearch(
  scroller: RefObject<HTMLElement | null>,
  revision: unknown,
  top: number,
  bottom: number
) {
  const [query, setQuery] = useState("")
  const [index, setIndex] = useState(0)
  const [count, setCount] = useState(0)
  const ranges = useRef<Range[]>([])
  const name = `document-search-${useId().replace(/[^a-zA-Z0-9]/g, "")}`
  useEffect(() => {
    const root = scroller.current
    const found: Range[] = []
    const needle = query
    if (root && needle) {
      for (const block of root.querySelectorAll("[data-document-text]")) {
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
          acceptNode: (node) =>
            node.parentElement?.closest("button, [role=status], style")
              ? NodeFilter.FILTER_REJECT
              : NodeFilter.FILTER_ACCEPT,
        })
        const nodes: { node: Node; start: number; end: number }[] = []
        let text = ""
        while (walker.nextNode()) {
          const node = walker.currentNode
          const start = text.length
          text += node.textContent
          nodes.push({ node, start, end: text.length })
        }
        // Case folding can change UTF-16 length (for example İ). RegExp indices
        // always refer to the original text and remain valid DOM offsets.
        const pattern = new RegExp(
          needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          "giu"
        )
        for (const match of text.matchAll(pattern)) {
          const from = match.index
          const length = match[0].length
          const first = nodes.find((node) => node.end > from)
          const last = nodes.find((node) => node.end >= from + length)
          if (!first || !last) continue
          const range = document.createRange()
          range.setStart(first.node, from - first.start)
          range.setEnd(last.node, from + length - last.start)
          found.push(range)
        }
      }
    }
    ranges.current = found
    let active = true
    queueMicrotask(() => {
      if (active) setCount(found.length)
    })
    if (typeof Highlight !== "undefined")
      CSS.highlights.set(name, new Highlight(...found))
    return () => {
      active = false
      if (typeof Highlight !== "undefined") CSS.highlights.delete(name)
    }
  }, [query, revision, scroller, name])
  useEffect(() => {
    const range = ranges.current[index % Math.max(1, count)]
    const root = scroller.current
    if (!range || !root) return
    const rect = range.getBoundingClientRect()
    const viewport = root.getBoundingClientRect()
    root.scrollBy({
      top:
        rect.top - viewport.top - top - (root.clientHeight - top - bottom) / 2,
    })
    if (typeof Highlight !== "undefined")
      CSS.highlights.set(`${name}-current`, new Highlight(range))
    return () => {
      if (typeof Highlight !== "undefined")
        CSS.highlights.delete(`${name}-current`)
    }
  }, [index, count, query, revision, top, bottom, scroller, name])
  return {
    query,
    count,
    current: count ? (index % count) + 1 : 0,
    setQuery: (value: string) => {
      setQuery(value)
      setIndex(0)
    },
    move: (direction: number) =>
      setIndex(
        (previous) =>
          (previous + direction + Math.max(1, count)) % Math.max(1, count)
      ),
    style: `::highlight(${name}) { background: var(--diff-added-gutter); color: inherit; } ::highlight(${name}-current) { background: var(--primary); color: var(--primary-foreground); }`,
  }
}
