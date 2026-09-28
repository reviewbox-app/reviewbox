"use client"

import { useEffect, useId, useState } from "react"
import { useTheme } from "next-themes"
import { MarkdownCodeBlock } from "./MarkdownCodeBlock"

// Mermaid has global configuration: serialize theme setup and rendering.
let renderQueue: Promise<void> = Promise.resolve()

export function MermaidBlock({
  chart,
  showSource = true,
}: {
  chart: string
  showSource?: boolean
}) {
  const { resolvedTheme } = useTheme()
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`
  const theme = resolvedTheme === "dark" ? "dark" : "default"
  const [result, setResult] = useState<{
    chart: string
    theme: string
    svg: string | null
  } | null>(null)
  const current =
    result?.chart === chart && result.theme === theme ? result : null

  useEffect(() => {
    let cancelled = false
    const render = async () => {
      if (cancelled) return
      try {
        const { default: mermaid } = await import("mermaid")
        if (cancelled) return
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme,
          fontFamily: "inherit",
          flowchart: { htmlLabels: false },
        })
        const valid = await mermaid.parse(chart, { suppressErrors: true })
        if (cancelled) return
        const svg = valid ? (await mermaid.render(id, chart)).svg : null
        if (!cancelled) setResult({ chart, theme, svg })
      } catch {
        if (!cancelled) setResult({ chart, theme, svg: null })
      } finally {
        document.getElementById(id)?.remove()
        document.getElementById(`d${id}`)?.remove()
      }
    }
    renderQueue = renderQueue.then(render, render)
    return () => {
      cancelled = true
    }
  }, [chart, id, theme])

  if (!current?.svg) {
    return (
      <div>
        <p className="text-xs text-muted-foreground" role="status">
          {current
            ? showSource
              ? "Diagram unavailable. Source shown below."
              : "Diagram unavailable."
            : "Rendering diagram…"}
        </p>
        {showSource && <MarkdownCodeBlock source={chart} language="mermaid" />}
      </div>
    )
  }

  return (
    <figure className="not-prose my-4 min-w-0">
      <div
        className="overflow-x-auto rounded-xl border bg-background p-4 [&_svg]:mx-auto [&_svg]:max-w-full"
        role="img"
        aria-label="Mermaid diagram"
        dangerouslySetInnerHTML={{ __html: current.svg }}
      />
      {showSource && (
        <details className="mt-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer">Diagram source</summary>
          {showSource && (
            <MarkdownCodeBlock source={chart} language="mermaid" />
          )}
        </details>
      )}
    </figure>
  )
}
