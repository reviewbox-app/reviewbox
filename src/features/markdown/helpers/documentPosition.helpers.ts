import type { SourceReadingPoint } from "../contracts/documentDiff.types"

export function documentReadingPoint(
  scroller: HTMLElement,
  top: number
): SourceReadingPoint {
  const viewport = scroller.getBoundingClientRect().top + top
  const blocks = Array.from(
    scroller.querySelectorAll<HTMLElement>("[data-source-start]")
  )
  const block =
    blocks.find(
      (element) => element.getBoundingClientRect().bottom > viewport
    ) ?? blocks.at(-1)
  if (!block) return { side: "after", line: 1, fraction: 0 }
  const rect = block.getBoundingClientRect()
  const start = Number(block.dataset.sourceStart)
  const end = Number(block.dataset.sourceEnd)
  const offset =
    Math.max(
      0,
      Math.min(0.999, (viewport - rect.top) / Math.max(1, rect.height))
    ) *
    (end - start + 1)
  return {
    side: block.dataset.sourceSide === "before" ? "before" : "after",
    line: start + Math.floor(offset),
    fraction: offset % 1,
  }
}

export function restoreDocumentPoint(
  scroller: HTMLElement,
  point: SourceReadingPoint,
  top: number
) {
  const blocks = Array.from(
    scroller.querySelectorAll<HTMLElement>("[data-source-start]")
  )
  const side = blocks.filter(
    (block) =>
      block.dataset.sourceSide === point.side ||
      block.dataset.unchanged === "true"
  )
  const candidates = side.length ? side : blocks
  const block =
    candidates.find(
      (element) => Number(element.dataset.sourceEnd) >= point.line
    ) ?? candidates.at(-1)
  if (!block) return
  const start = Number(block.dataset.sourceStart)
  const end = Number(block.dataset.sourceEnd)
  const fraction = Math.max(
    0,
    Math.min(1, (point.line + point.fraction - start) / (end - start + 1))
  )
  const rect = block.getBoundingClientRect()
  scroller.scrollTop +=
    rect.top -
    scroller.getBoundingClientRect().top +
    fraction * rect.height -
    top
}

export function sameReadingPoint(
  a?: SourceReadingPoint,
  b?: SourceReadingPoint
) {
  return (
    !!a &&
    !!b &&
    a.side === b.side &&
    a.line === b.line &&
    Math.abs(a.fraction - b.fraction) < 0.05
  )
}
