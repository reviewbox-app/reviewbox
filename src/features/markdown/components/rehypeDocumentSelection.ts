import type { Root, Element, RootContent } from "hast"

/** Attach exact source offsets to authored text, after sanitization. */
export function rehypeDocumentSelection(options: { source: string }) {
  return (tree: Root) => {
    function visit(parent: Root | Element) {
      parent.children = parent.children.map((node): RootContent => {
        if (node.type === "element") {
          if (!["pre", "script", "style"].includes(node.tagName)) visit(node)
          return node
        }
        if (node.type !== "text" || !node.value) return node
        const position =
          node.position ??
          (parent.type === "element" && parent.tagName === "code"
            ? parent.position
            : undefined)
        if (!position) return node
        const { start, end } = position
        if (start.offset === undefined || end.offset === undefined) return node
        const raw = options.source.slice(start.offset, end.offset)
        const inner = raw.indexOf(node.value)
        // Do not invent an offset for decoded entities or generated text.
        if (inner < 0) return node
        const offset = start.offset + inner
        return {
          type: "element",
          tagName: "span",
          properties: {
            "data-document-start": offset,
            "data-document-end": offset + node.value.length,
          },
          children: [node],
        }
      }) as typeof parent.children
    }
    visit(tree)
  }
}
