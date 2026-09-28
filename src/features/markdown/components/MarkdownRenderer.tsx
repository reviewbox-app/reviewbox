"use client"

import type { DocumentTerm } from "@/lib/desktop/contracts.generated"
import { remarkReview } from "./remarkReview"
import { cn } from "@/lib/utils"
import {
  Children,
  isValidElement,
  memo,
  useId,
  useMemo,
  type ReactNode,
} from "react"
import Markdown, {
  defaultUrlTransform,
  type Components,
  type Options,
} from "react-markdown"
import rehypeRaw from "rehype-raw"
import rehypeSanitize, { defaultSchema } from "rehype-sanitize"
import remarkBreaks from "remark-breaks"
import remarkGfm from "remark-gfm"
import { MarkdownCodeBlock } from "./MarkdownCodeBlock"
import { MermaidBlock } from "./MermaidBlock"

const remarkPlugins: Options["remarkPlugins"] = [remarkGfm, remarkBreaks]

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
    return <MarkdownCodeBlock source={source} language={language} />
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
  renderLink,
  renderCodeBlock,
  glossary = [],
  illustrations = false,
}: {
  children: string
  glossary?: DocumentTerm[]
  illustrations?: boolean
  className?: string
  /** Embedded HTML is sanitized; scripts, handlers and unsafe URLs are removed. */
  allowHtml?: boolean
  renderLink?: (href: string, children: ReactNode) => ReactNode | undefined
  renderCodeBlock?: (source: string, language?: string) => ReactNode | undefined
}) {
  const prefix = `markdown-${useId().replace(/[^a-zA-Z0-9-]/g, "")}-`
  const rehypePlugins = useMemo<Options["rehypePlugins"]>(
    () => [
      ...(allowHtml ? [rehypeRaw] : []),
      // Prefix IDs once, including footnotes. Highlighting renders trusted text spans separately.
      [
        rehypeSanitize,
        {
          ...defaultSchema,
          clobberPrefix: prefix,
          protocols: {
            ...defaultSchema.protocols,
            href: [
              ...(defaultSchema.protocols?.href ?? []),
              ...(renderLink ? ["reviewbox"] : []),
            ],
          },
        },
      ],
    ],
    [allowHtml, prefix, renderLink]
  )
  const renderers = useMemo<Components>(
    () => ({
      ...components,
      pre: ({ children }) => {
        const code = Children.toArray(children).find(isValidElement)
        const language = isValidElement<{ className?: string }>(code)
          ? /(?:^|\s)language-([^\s]+)/.exec(code.props.className ?? "")?.[1]
          : undefined
        const source = textContent(children)
        const custom = renderCodeBlock?.(source, language)
        if (custom !== undefined) return custom
        if (language === "mermaid")
          return <MermaidBlock chart={source.trim()} />
        return <MarkdownCodeBlock source={source} language={language} />
      },
      a: ({ node, href, ...props }) => {
        void node
        const custom = href && renderLink?.(href, props.children)
        if (custom !== undefined && custom !== "") return custom
        if (href?.startsWith("reviewbox:")) return <span>{props.children}</span>
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
    [prefix, renderLink, renderCodeBlock]
  )
  return (
    <div
      className={cn(
        "markdown prose prose-sm max-w-none min-w-0 wrap-anywhere",
        className
      )}
    >
      <Markdown
        remarkPlugins={[
          ...remarkPlugins,
          [remarkReview, { terms: glossary, illustrations }],
        ]}
        rehypePlugins={rehypePlugins}
        remarkRehypeOptions={{ clobberPrefix: "" }}
        skipHtml={!allowHtml}
        urlTransform={(url) =>
          renderLink && /^reviewbox:(ref|term)\/[a-zA-Z0-9_-]+$/.test(url)
            ? url
            : defaultUrlTransform(url)
        }
        components={renderers}
      >
        {children}
      </Markdown>
    </div>
  )
})
