import type { DocumentTextRange } from "@/lib/desktop/contracts.generated"

export function documentRanges(
  root: HTMLElement,
  selection: Selection
): DocumentTextRange[] | null {
  if (selection.isCollapsed || selection.rangeCount !== 1) return null
  const range = selection.getRangeAt(0)
  if (
    !root.contains(range.startContainer) ||
    !root.contains(range.endContainer)
  )
    return null
  const spanFor = (node: Node) =>
    (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(
      "[data-document-start]"
    )
  if (!spanFor(range.startContainer) || !spanFor(range.endContainer))
    return null
  const ranges: DocumentTextRange[] = []
  for (const span of root.querySelectorAll<HTMLElement>(
    "[data-document-start]"
  )) {
    if (!range.intersectsNode(span)) continue
    const node = span.firstChild
    if (!node || node.nodeType !== Node.TEXT_NODE) continue
    const from = range.startContainer === node ? range.startOffset : 0
    const to =
      range.endContainer === node ? range.endOffset : node.textContent!.length
    if (to <= from) continue
    const start = Number(span.dataset.documentStart) + from
    const end = Number(span.dataset.documentStart) + to
    if (ranges.length && start < ranges[ranges.length - 1].end) return null
    ranges.push({ start, end })
  }
  return ranges.length ? ranges : null
}
export async function documentHash(body: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body)
  )
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}
