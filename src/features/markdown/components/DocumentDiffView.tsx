"use client"

import {
  Component,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type {
  DocumentBlock,
  DocumentDiffRow,
  SourceReadingPoint,
  DocumentViewHandle,
  DocumentViewPosition,
} from "../contracts/documentDiff.types"
import { useDocumentDiff } from "../hooks/useDocumentDiff"
import { useDocumentSearch } from "../hooks/useDocumentSearch"
import {
  documentReadingPoint,
  restoreDocumentPoint,
  sameReadingPoint,
} from "../helpers/documentPosition.helpers"
import { MarkdownTreeRenderer } from "./MarkdownRenderer"

class RenderBoundary extends Component<
  { children: ReactNode; onCode: () => void },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? (
      <PreviewError onCode={this.props.onCode} />
    ) : (
      this.props.children
    )
  }
}

function PreviewError({
  onCode,
  message,
}: {
  onCode: () => void
  message?: string
}) {
  return (
    <div role="alert" className="space-y-3 p-6 text-sm">
      <p>{message ?? "This file could not be rendered as Markdown."}</p>
      <Button variant="secondary" onClick={onCode}>
        Open in code
      </Button>
    </div>
  )
}

function Block({
  block,
  side,
  changed,
  detail,
  prefix,
}: {
  block?: DocumentBlock
  side: "before" | "after"
  changed: boolean
  detail?: string
  prefix: string
}) {
  if (!block) return <div aria-hidden="true" className="document-diff-empty" />
  return (
    <section
      className="document-diff-block"
      data-change={
        changed ? (side === "before" ? "removed" : "added") : "unchanged"
      }
      data-source-start={block.lines.start}
      data-source-end={block.lines.end}
      data-source-side={side}
      data-unchanged={!changed}
    >
      <div className="document-diff-label">
        <span
          aria-label={
            changed ? (side === "before" ? "Removed" : "Added") : "Unchanged"
          }
        >
          {changed ? (side === "before" ? "−" : "+") : "·"}
        </span>
        <span>
          {side === "before" ? "Before" : "After"} L{block.lines.start}
          {block.lines.end !== block.lines.start ? `–${block.lines.end}` : ""}
        </span>
        {detail && <span className="document-diff-detail">{detail}</span>}
      </div>
      <MarkdownTreeRenderer tree={block.tree} prefix={prefix} />
    </section>
  )
}

function Row({
  row,
  split,
  prefix,
}: {
  row: DocumentDiffRow
  split: boolean
  prefix: string
}) {
  return (
    <div className="document-diff-row">
      {(split || row.changed) && (
        <Block
          block={row.before}
          side="before"
          changed={row.changed}
          detail={row.detail}
          prefix={`${prefix}before-`}
        />
      )}
      {(split || row.after) && (
        <Block
          block={row.after}
          side="after"
          changed={row.changed}
          detail={row.detail}
          prefix={`${prefix}after-`}
        />
      )}
    </div>
  )
}

export function DocumentDiffView({
  before,
  after,
  split,
  padding,
  point,
  saved,
  onCapture,
  onCounts,
  onCode,
  handle,
}: {
  before: string | null
  after: string | null
  split: boolean
  padding: { top: number; bottom: number }
  point?: SourceReadingPoint
  saved?: DocumentViewPosition
  onCapture: (position: DocumentViewPosition) => void
  onCounts: (counts: { added: number; removed: number }) => void
  onCode: () => void
  handle: Ref<DocumentViewHandle>
}) {
  const state = useDocumentDiff(before, after)
  const root = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [finding, setFinding] = useState(false)
  const prefix = `document-${useId().replace(/[^a-zA-Z0-9]/g, "")}-`
  const search = useDocumentSearch(
    root,
    state?.result,
    padding.top + (finding ? 44 : 0),
    padding.bottom
  )
  const latest = useRef({ onCapture, split, padding })
  const initial = useRef({ point, saved })
  const initialized = useRef(false)
  useLayoutEffect(() => {
    latest.current = { onCapture, split, padding }
  })
  const capture = () =>
    root.current && initialized.current
      ? {
          point: documentReadingPoint(root.current, latest.current.padding.top),
          scrollTop: root.current.scrollTop,
          split: latest.current.split,
        }
      : undefined
  useImperativeHandle(handle, () => ({
    capture,
    find: () => {
      setFinding(true)
      requestAnimationFrame(() => input.current?.focus())
    },
  }))
  useEffect(() => {
    if (state?.result) onCounts(state.result)
  }, [state?.result, onCounts])
  useLayoutEffect(() => {
    const scroller = root.current
    if (!state?.result || !scroller || initialized.current) return
    const { point, saved } = initial.current
    if (saved?.split === split && sameReadingPoint(point, saved.point))
      scroller.scrollTop = saved.scrollTop ?? 0
    else if (point) restoreDocumentPoint(scroller, point, padding.top)
    initialized.current = true
  }, [state?.result, split, padding.top])
  useEffect(
    () => () => {
      const position = capture()
      if (position) latest.current.onCapture(position)
    },
    []
  )
  return (
    <div
      className="relative h-full min-h-0"
      onKeyDown={(event) => {
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "f"
        ) {
          event.preventDefault()
          setFinding(true)
          requestAnimationFrame(() => input.current?.focus())
        }
        if (event.key === "Escape" && finding) {
          setFinding(false)
          search.setQuery("")
          root.current?.focus()
        }
      }}
    >
      {finding && (
        <div
          role="search"
          aria-label="Find in rendered document"
          className="absolute right-3 left-3 z-20 flex items-center gap-2 rounded-xl border glass-bar p-2"
          style={{ top: padding.top }}
        >
          <Input
            ref={input}
            aria-label="Find in document"
            value={search.query}
            onChange={(event) => search.setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                search.move(event.shiftKey ? -1 : 1)
              }
            }}
          />
          <span role="status" className="shrink-0 text-xs tabular-nums">
            {search.current} / {search.count}
          </span>
          <Button
            size="xs"
            variant="ghost"
            aria-label="Previous match"
            onClick={() => search.move(-1)}
            disabled={!search.count}
          >
            ↑
          </Button>
          <Button
            size="xs"
            variant="ghost"
            aria-label="Next match"
            onClick={() => search.move(1)}
            disabled={!search.count}
          >
            ↓
          </Button>
          <Button
            size="xs"
            variant="ghost"
            aria-label="Close document search"
            onClick={() => {
              setFinding(false)
              search.setQuery("")
              root.current?.focus()
            }}
          >
            ×
          </Button>
        </div>
      )}
      <style>{search.style}</style>
      <div
        ref={root}
        tabIndex={0}
        role="region"
        aria-label="Markdown file diff"
        data-layout={split ? "split" : "unified"}
        className="document-diff h-full overflow-y-auto outline-none"
        style={{ paddingTop: padding.top, paddingBottom: padding.bottom }}
        onScroll={() => {
          const position = capture()
          if (position) onCapture(position)
        }}
      >
        {state?.error ? (
          <PreviewError message={state.error} onCode={onCode} />
        ) : state?.result ? (
          <RenderBoundary onCode={onCode}>
            {state.result.rows.length ? (
              state.result.rows.map((row, index) => (
                <Row key={index} row={row} split={split} prefix={prefix} />
              ))
            ) : (
              <p className="p-6 text-sm text-muted-foreground">
                Empty document
              </p>
            )}
          </RenderBoundary>
        ) : (
          <p role="status" className="p-6 text-sm text-muted-foreground">
            Rendering Markdown…
          </p>
        )}
      </div>
    </div>
  )
}
