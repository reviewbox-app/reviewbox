import { memo } from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"

/** Title formatting, safe inside headings, buttons and truncated labels. */
export const InlineMarkdown = memo(function InlineMarkdown({
  children,
}: {
  children: string
}) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      allowedElements={["strong", "em", "code", "del"]}
      unwrapDisallowed
      skipHtml
      components={{
        code: ({ children }) => (
          <code className="rounded bg-muted/60 px-1 py-0.5 font-mono text-[0.9em]">
            {children}
          </code>
        ),
      }}
    >
      {children}
    </Markdown>
  )
})
