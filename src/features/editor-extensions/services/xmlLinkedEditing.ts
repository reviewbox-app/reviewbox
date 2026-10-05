import { parse } from "@xml-tools/parser"
import type {
  ElementCstNode,
  ContentCstNode,
  DocumentCstNode,
} from "@xml-tools/parser"

/** CST boundaries exclude attributes, comments, CDATA and similarly named nested tags. */
export function xmlLinkedRanges(
  text: string,
  offset: number
): { start: number; end: number }[] | undefined {
  if (text.length > 1024 * 1024) return
  const { cst } = parse(text)
  let result: ReturnType<typeof xmlLinkedRanges>
  function visit(element: ElementCstNode) {
    const opening = element.children.Name?.[0],
      closing = element.children.END_NAME?.[0]
    if (
      opening &&
      closing &&
      opening.image === closing.image &&
      [opening, closing].some(
        (t) =>
          offset >= t.startOffset &&
          offset <= (t.endOffset ?? t.startOffset) + 1
      )
    )
      result = [opening, closing].map((t) => ({
        start: t.startOffset,
        end: (t.endOffset ?? t.startOffset) + 1,
      }))
    for (const content of element.children.content ?? [])
      for (const child of (content as ContentCstNode).children.element ?? [])
        visit(child)
  }
  for (const element of (cst as DocumentCstNode).children.element ?? [])
    visit(element)
  return result
}
