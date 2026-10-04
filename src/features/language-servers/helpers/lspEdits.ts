import type * as L from "vscode-languageserver-protocol"

export function replaceText(text: string, edits: L.TextEdit[]) {
  const lines = text.split("\n")
  const offset = (p: L.Position) => {
    if (
      p.line < 0 ||
      p.line >= lines.length ||
      p.character < 0 ||
      p.character > lines[p.line].replace(/\r$/, "").length
    )
      throw new Error("The server returned an invalid edit range.")
    return (
      lines.slice(0, p.line).reduce((n, line) => n + line.length + 1, 0) +
      p.character
    )
  }
  const changes = edits
    .map((e) => ({
      start: offset(e.range.start),
      end: offset(e.range.end),
      text: e.newText,
    }))
    .sort((a, b) => b.start - a.start)
  let last = text.length + 1
  for (const e of changes) {
    if (e.start > e.end || e.end > last)
      throw new Error("The server returned overlapping edits.")
    text = text.slice(0, e.start) + e.text + text.slice(e.end)
    last = e.start
  }
  return text
}
