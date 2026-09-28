# Markdown rendering

Use `MarkdownRenderer` for read-only Markdown. It follows the Naura Prospekt
`MdParser` approach with ReviewBox typography and theme tokens.

```tsx
import { MarkdownRenderer } from "@/features/markdown/components/MarkdownRenderer"

;<MarkdownRenderer>{content}</MarkdownRenderer>
```

- `remark-gfm`: tables, task lists, strike-through, autolinks and footnotes.
- `remark-breaks`: preserve single line breaks.
- `rehype-raw` + `rehype-sanitize`: render benign HTML while filtering scripts,
  handlers and unsafe URLs. Set `allowHtml={false}` to omit embedded HTML.
- Shiki/TextMate: locally bundled lazy grammars and the same Tokyo Night / ReviewBox
  syntax palette as Monaco. Static snippets render escaped token spans, not HTML.
- A shared pseudo-code lexer recognizes control flow, functions, parameters,
  properties and literals in documents, diffs and reference cards.
- Code blocks have a copy button; inline code keeps inline styling.
- Mermaid loads only when a diagram is mounted, uses strict security, follows
  the application theme and falls back to copyable source on invalid input.
- `@tailwindcss/typography` supplies the `prose` foundation. Scoped overrides live
  in `styles/markdown.css`, imported by the global stylesheet.

The renderer owns no scroll container; its parent controls available height.
Code wraps by default; tables and diagrams contain their own horizontal
overflow. Links and images remain subject to the desktop application's
navigation policy and CSP.
No filesystem access or native command is added by this feature.

Validation: `bun run test` covers the renderer. After
`bun run build:native-validation`, `bun run test:ui:progress` exercises Markdown
commentary in the native preparation activity feed with a fixture provider.

## Review documents

`ReviewMarkdown` adds controlled `reviewbox:ref/<id>` and `reviewbox:term/<id>`
links and the `before-after`, `summary`, `pseudocode`, `source` and `mermaid` fences.
Illustrations use isolated frames; their HTML/CSS/JavaScript never enter the
reader DOM. Source blocks contain a validated reference ID; the renderer loads
captured source through the reader facade. Model-written real-code fences are
never substituted for captured code. Pseudo-code blocks are available at all
reading levels; source reference cards expose real code only in Developer.
Intermediate renders translated ranges and displays an explicit unavailable
state for omitted passages.
Hover/focus previews have clickable keyboard-accessible detail dialogs and can
open alongside a document without changing its validation scope.
