"use client"

import { useEffect, useRef, useState } from "react"

/** Resizes its containing sidebar without remounting the adjacent editor. */
export function SidebarResizeHandle({
  name,
  property,
  minWidth = 180,
  maxRatio = 0.35,
}: {
  name: string
  property: `--${string}`
  minWidth?: number
  maxRatio?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; width: number } | null>(null)
  const [width, setWidth] = useState(minWidth)
  const [maximum, setMaximum] = useState(minWidth)
  const key = `reviewbox.panel-width.${property}`

  useEffect(() => {
    const panel = ref.current?.parentElement
    const workspace = panel?.closest<HTMLElement>("[data-resize-workspace]")
    if (!panel || !workspace) return
    try {
      const saved = Number(localStorage.getItem(key))
      if (Number.isFinite(saved) && saved >= minWidth)
        workspace.style.setProperty(property, `${Math.min(saved, 1200)}px`)
    } catch {
      // Resizing remains available when browser preference storage is disabled.
    }
    const observer = new ResizeObserver(() => {
      setWidth(Math.round(panel.getBoundingClientRect().width))
      setMaximum(
        Math.max(minWidth, Math.floor(workspace.clientWidth * maxRatio))
      )
    })
    observer.observe(panel)
    observer.observe(workspace)
    return () => observer.disconnect()
  }, [key, property, minWidth, maxRatio])

  function resize(value: number) {
    const workspace = ref.current?.closest<HTMLElement>(
      "[data-resize-workspace]"
    )
    if (!workspace) return
    const max = Math.max(minWidth, Math.floor(workspace.clientWidth * maxRatio))
    const next = Math.round(Math.max(minWidth, Math.min(max, value)))
    workspace.style.setProperty(property, `${next}px`)
  }

  function remember() {
    const value = ref.current?.parentElement?.getBoundingClientRect().width
    if (value === undefined) return
    try {
      localStorage.setItem(key, String(Math.round(value)))
    } catch {
      // Preferences are optional; never interrupt a pointer interaction.
    }
  }

  return (
    <div
      ref={ref}
      role="separator"
      aria-label={`Resize ${name}`}
      aria-orientation="vertical"
      aria-valuemin={minWidth}
      aria-valuemax={maximum}
      aria-valuenow={width}
      aria-valuetext={`${width} pixels`}
      tabIndex={0}
      className="absolute inset-y-0 -right-1 z-40 w-2 cursor-col-resize touch-none select-none before:absolute before:inset-y-0 before:left-1/2 before:w-px hover:before:bg-primary focus-visible:outline-2 focus-visible:outline-primary active:before:bg-primary"
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.currentTarget.focus()
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = {
          x: event.clientX,
          width:
            event.currentTarget.parentElement!.getBoundingClientRect().width,
        }
      }}
      onPointerMove={(event) => {
        if (drag.current)
          resize(drag.current.width + event.clientX - drag.current.x)
      }}
      onPointerUp={(event) => {
        if (!drag.current) return
        drag.current = null
        remember()
        event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      onPointerCancel={() => {
        drag.current = null
        remember()
      }}
      onLostPointerCapture={() => {
        drag.current = null
      }}
      onKeyDown={(event) => {
        const current =
          event.currentTarget.parentElement!.getBoundingClientRect().width
        const step = event.shiftKey ? 40 : 10
        const next =
          event.key === "ArrowLeft"
            ? current - step
            : event.key === "ArrowRight"
              ? current + step
              : event.key === "Home"
                ? minWidth
                : event.key === "End"
                  ? maximum
                  : null
        if (next === null) return
        event.preventDefault()
        event.stopPropagation()
        resize(next)
        remember()
      }}
    />
  )
}
