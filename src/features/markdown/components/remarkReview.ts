import type { DocumentTerm } from "@/lib/desktop/contracts.generated"

interface Node {
  type: string
  value?: string
  lang?: string
  url?: string
  children?: Node[]
}
const word = (char: string | undefined) => !!char && /[\p{L}\p{N}_]/u.test(char)

/** Only prose is linked: existing links, code and illustrations remain untouched. */
export function remarkReview(options: {
  terms: DocumentTerm[]
  illustrations?: boolean
}) {
  const terms = options.terms
    .filter(
      (term, index, all) =>
        !all.some(
          (other, otherIndex) =>
            otherIndex !== index &&
            other.term.toLowerCase() === term.term.toLowerCase() &&
            other.id !== term.id
        )
    )
    .sort((a, b) => b.term.length - a.term.length)
  function visit(node: Node) {
    if (["link", "linkReference", "code", "inlineCode"].includes(node.type))
      return
    if (!node.children) return
    node.children = node.children.flatMap((child): Node[] => {
      if (
        child.type === "html" &&
        options.illustrations &&
        node.type !== "paragraph"
      )
        return [{ type: "code", lang: "html", value: child.value }]
      if (child.type !== "text" || !child.value) {
        visit(child)
        return [child]
      }
      const text = child.value
      const result: Node[] = []
      let start = 0
      for (let offset = 0; offset < text.length;) {
        const found = terms.find(
          (term) =>
            term.term &&
            text.slice(offset, offset + term.term.length).toLowerCase() ===
              term.term.toLowerCase() &&
            !word(text[offset - 1]) &&
            !word(text[offset + term.term.length])
        )
        if (!found) {
          offset++
          continue
        }
        if (start < offset)
          result.push({ type: "text", value: text.slice(start, offset) })
        result.push({
          type: "link",
          url: `reviewbox:term/${found.id}`,
          children: [
            {
              type: "text",
              value: text.slice(offset, offset + found.term.length),
            },
          ],
        })
        offset += found.term.length
        start = offset
      }
      if (start < text.length)
        result.push({ type: "text", value: text.slice(start) })
      return result
    })
  }
  return visit
}
