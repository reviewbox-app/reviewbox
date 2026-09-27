"use client"

import { cn } from "@/lib/utils"
import {
  Children,
  isValidElement,
  memo,
  useId,
  useMemo,
  type ReactNode,
} from "react"
import Markdown, { type Components, type Options } from "react-markdown"
import rehypeHighlight from "rehype-highlight"
import rehypeRaw from "rehype-raw"
import rehypeSanitize, { defaultSchema } from "rehype-sanitize"
import remarkBreaks from "remark-breaks"
import remarkGfm from "remark-gfm"
import { MarkdownCodeBlock } from "./MarkdownCodeBlock"
import { MermaidBlock } from "./MermaidBlock"

const remarkPlugins: Options["remarkPlugins"] = [remarkGfm, remarkBreaks]
const highlighting: NonNullable<Options["rehypePlugins"]> = [
  [rehypeHighlight, { plainText: ["mermaid"], detect: false }],
]

function textContent(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number")
        return String(child)
      return isValidElement<{ children?: ReactNode }>(child)
        ? textContent(child.props.children)
        : ""
    })
    .join("")
}

const components: Components = {
  pre: ({ children }) => {
    const code = Children.toArray(children).find((child) =>
      isValidElement<{ className?: string }>(child)
    )
    const language = isValidElement<{ className?: string }>(code)
      ? /(?:^|\s)language-([^\s]+)/.exec(code.props.className ?? "")?.[1]
      : undefined
    const source = textContent(children)
    if (language === "mermaid") return <MermaidBlock chart={source.trim()} />
    return (
      <MarkdownCodeBlock source={source} language={language}>
        {children}
      </MarkdownCodeBlock>
    )
  },
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto">
      <table>{children}</table>
    </div>
  ),
}

export const MarkdownRenderer = memo(function MarkdownRenderer({
  children,
  className,
  allowHtml = true,
}: {
  children: string
  className?: string
  /** Embedded HTML is sanitized; scripts, handlers and unsafe URLs are removed. */
  allowHtml?: boolean
}) {
  const prefix = `markdown-${useId().replace(/[^a-zA-Z0-9-]/g, "")}-`
  const rehypePlugins = useMemo<Options["rehypePlugins"]>(
    () => [
      ...(allowHtml ? [rehypeRaw] : []),
      // Prefix IDs once, including footnotes, before adding trusted highlight spans.
      [rehypeSanitize, { ...defaultSchema, clobberPrefix: prefix }],
      ...highlighting,
    ],
    [allowHtml, prefix]
  )
  const renderers = useMemo<Components>(
    () => ({
      ...components,
      a: ({ node, href, ...props }) => {
        void node
        const fragment = href?.startsWith("#")
        return (
          <a
            {...props}
            href={fragment ? `#${prefix}${href?.slice(1)}` : href}
            aria-describedby={props["aria-describedby"]
              ?.split(" ")
              .map((id) => `${prefix}${id}`)
              .join(" ")}
            target={fragment ? undefined : "_blank"}
            rel="noopener noreferrer"
          />
        )
      },
    }),
    [prefix]
  )
  return (
    <div
      className={cn(
        "markdown prose prose-sm max-w-none min-w-0 wrap-anywhere",
        className
      )}
    >
      <Markdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        remarkRehypeOptions={{ clobberPrefix: "" }}
        skipHtml={!allowHtml}
        components={renderers}
      >
        {children}
      </Markdown>
    </div>
  )
})
