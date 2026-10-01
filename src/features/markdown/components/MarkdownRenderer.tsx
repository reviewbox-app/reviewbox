"use client"

import type { DocumentTerm } from "@/lib/desktop/contracts.generated"
import { remarkReview } from "./remarkReview"
import { cn } from "@/lib/utils"
import type { Root, Nodes } from "hast"
import { toJsxRuntime } from "hast-util-to-jsx-runtime"
import { Fragment, jsx, jsxs } from "react/jsx-runtime"
import {
  Children,
  createContext,
  isValidElement,
  memo,
  useContext,
  useId,
  useMemo,
  type ComponentProps,
  type ReactNode,
} from "react"
import Markdown, {
  defaultUrlTransform,
  type Components,
  type ExtraProps,
  type Options,
} from "react-markdown"
import rehypeRaw from "rehype-raw"
import rehypeSanitize, { defaultSchema } from "rehype-sanitize"
import remarkBreaks from "remark-breaks"
import remarkGfm from "remark-gfm"
import { MarkdownCodeBlock } from "./MarkdownCodeBlock"
import { MermaidBlock } from "./MermaidBlock"

const remarkPlugins: Options["remarkPlugins"] = [remarkGfm, remarkBreaks]

type Rendering = {
  prefix: string
  renderLink?: (href: string, children: ReactNode) => ReactNode | undefined
  renderCodeBlock?: (source: string, language?: string) => ReactNode | undefined
}
const RenderingContext = createContext<Rendering>({ prefix: "" })

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

function MarkdownPre({ children, node }: ComponentProps<"pre"> & ExtraProps) {
  const { renderCodeBlock } = useContext(RenderingContext)
  const code = Children.toArray(children).find(isValidElement)
  const language = isValidElement<{ className?: string }>(code)
    ? /(?:^|\s)language-([^\s]+)/.exec(code.props.className ?? "")?.[1]
    : undefined
  const source = textContent(children)
  const custom = renderCodeBlock?.(source, language)
  if (custom !== undefined) return custom
  const highlights: { start: number; end: number }[] = []
  let offset = 0
  function visit(item: Nodes) {
    const start = offset
    if (item.type === "text") offset += item.value.length
    if ("children" in item) item.children.forEach(visit)
    if (item.type === "element" && item.tagName === "mark")
      highlights.push({ start, end: offset })
  }
  if (node) visit(node)
  // Diffed diagrams retain their source so their actual edits stay visible.
  if (language === "mermaid" && !highlights.length)
    return <MermaidBlock chart={source.trim()} />
  return (
    <MarkdownCodeBlock
      source={source}
      language={language}
      highlights={highlights}
    />
  )
}

function MarkdownLink({
  node,
  href,
  ...props
}: ComponentProps<"a"> & ExtraProps) {
  void node
  const { prefix, renderLink } = useContext(RenderingContext)
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
}

// These component types must stay stable: recreating them when callbacks change
// unmounts interactive links, open dialogs and illustrations during native polling.
const components: Components = {
  pre: MarkdownPre,
  a: MarkdownLink,
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto">
      <table>{children}</table>
    </div>
  ),
}

/** Only accepts the sanitized HAST produced by the document worker. */
export const MarkdownTreeRenderer = memo(function MarkdownTreeRenderer({
  tree,
  prefix,
}: {
  tree: Root
  prefix: string
}) {
  const rendering = useMemo(() => ({ prefix }), [prefix])
  const content = useMemo(() => {
    const copy = structuredClone(tree)
    function scope(node: Nodes) {
      if (node.type === "element") {
        if (node.properties.id)
          node.properties.id = `${prefix}${node.properties.id}`
        if (typeof node.properties.href === "string")
          node.properties.href = defaultUrlTransform(node.properties.href)
        if (typeof node.properties.src === "string")
          node.properties.src = defaultUrlTransform(node.properties.src)
      }
      if ("children" in node) node.children.forEach(scope)
    }
    scope(copy)
    return toJsxRuntime(copy, {
      Fragment,
      jsx,
      jsxs,
      components,
      passNode: true,
    })
  }, [tree, prefix])
  return (
    <div
      className="markdown prose prose-sm max-w-none min-w-0 wrap-anywhere"
      data-document-text
    >
      <RenderingContext.Provider value={rendering}>
        {content}
      </RenderingContext.Provider>
    </div>
  )
})

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
  const hasCustomLinks = !!renderLink
  const rendering = useMemo(
    () => ({ prefix, renderLink, renderCodeBlock }),
    [prefix, renderLink, renderCodeBlock]
  )
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
              ...(hasCustomLinks ? ["reviewbox"] : []),
            ],
          },
        },
      ],
    ],
    [allowHtml, prefix, hasCustomLinks]
  )
  return (
    <div
      className={cn(
        "markdown prose prose-sm max-w-none min-w-0 wrap-anywhere",
        className
      )}
    >
      <RenderingContext.Provider value={rendering}>
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
          components={components}
        >
          {children}
        </Markdown>
      </RenderingContext.Provider>
    </div>
  )
})
