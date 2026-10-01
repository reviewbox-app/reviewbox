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
  properties and literals in reusable Markdown/Monaco highlighting and old documents.
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

## Captured document diffs

`DocumentDiffView` renders complete `FileContent.before/after` values. The local
`document-diff` worker parses each complete Markdown document with GFM, preserved
line breaks and sanitized HTML before comparing blocks and their visible text.
Source positions travel with the blocks. Whole-word comparisons preserve Unicode;
formatting, link and image changes are signaled even when visible text is identical.
Adjacent changed words share one highlight including their single space; spacing-only
edits, repeated spaces and tabs remain unmarked. Entirely added or removed blocks
use only their background, with no inline marks. Similarity aligns replacements
around inserted blocks before their words are compared.
Unified shows old/new changed blocks in sequence; Split aligns corresponding
blocks in a single scrolling grid. No context is collapsed.
Each document column is centered with the review reader's 720px maximum width.

`MarkdownTreeRenderer` reuses the same components and styles for the worker's
sanitized trees, including code colors and exact changed-text marks. Captured
content is never executed. Resource loading follows the existing desktop CSP.
The worker build uses the `worker` export condition, including the DOM-free
Markdown entity decoder. Disposing or superseding a preview terminates its worker.

Markdown/text files and conventional README/license names default to this preview.
Known code languages take precedence; MDX, AsciiDoc and reStructuredText remain
code. The file-header toggle, reading point and both view positions are session
state for each capture. The main Document/Code switch still selects Rev's explanation
versus captured files. An explicit source reference always opens and centers raw code.
Preview search reads rendered text; Monaco display options only apply to code.

Validation: `bun run test`, `bun run test:web` and, after the native validation build,
`bun run test:ui:document-diff`. The development fixture lives at `/dev/document-diff/`.

Validation: `bun run test` covers the renderer. After
`bun run build:native-validation`, `bun run test:ui:progress` exercises Markdown
commentary in the native preparation activity feed with a fixture provider.

## Review documents

`ReviewMarkdown` adds controlled `reviewbox:ref/<id>` and `reviewbox:term/<id>`
links and the `before-after`, `summary`, `pseudocode`, `source` and `mermaid` fences.
Illustrations use isolated frames; their HTML/CSS/JavaScript never enter the
reader DOM. Source blocks contain a validated reference ID and render an explanation
with an Open in code button. Reference cards expose this same action at every reading
level without loading source at hover time. The host opens the exact captured range
in the full Code view while retaining the current decision scope.
Model-written real-code fences never replace captured source. Legacy pseudo-code
blocks retain their coloring; preparation no longer generates them.
