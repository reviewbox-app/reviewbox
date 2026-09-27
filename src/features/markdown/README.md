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
- `rehype-highlight`: bundled common languages, with plain code for unknown ones.
- Code blocks have a copy button; inline code keeps inline styling.
- Mermaid loads only when a diagram is mounted, uses strict security, follows
  the application theme and falls back to copyable source on invalid input.
- `@tailwindcss/typography` supplies the `prose` foundation. Scoped overrides live
  in `styles/markdown.css`, imported by the global stylesheet.

The renderer owns no scroll container; its parent controls available height.
Tables, code and diagrams contain their own horizontal overflow. Links and
images remain subject to the desktop application's navigation policy and CSP.
No filesystem access or native command is added by this feature.

Validation: `bun run test` covers the renderer. After
`bun run build:native-validation`, `bun run test:ui:progress` exercises Markdown
commentary in the native preparation activity feed with a fixture provider.
