"use client"

import { useEffect, useRef, useState, type RefObject } from "react"
import { cn } from "@/lib/utils"

/** Resizes its containing sidebar without remounting the adjacent editor. */
export function SidebarResizeHandle({
  name,
  property,
  minWidth = 180,
  maxRatio = 0.35,
  side = "left",
  edge = side === "right" ? "left" : "right",
  panelRef,
}: {
  name: string
  property: `--${string}`
  minWidth?: number
  maxRatio?: number
  side?: "left" | "right"
  edge?: "left" | "right"
  panelRef?: RefObject<HTMLElement | null>
}) {
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; width: number } | null>(null)
  const [width, setWidth] = useState(minWidth)
  const [maximum, setMaximum] = useState(minWidth)
  const key = `reviewbox.panel-width.${property}`
  const direction = side === "right" ? -1 : 1

  useEffect(() => {
    const panel = panelRef?.current ?? ref.current?.parentElement
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
  }, [key, property, minWidth, maxRatio, panelRef])

  function resize(value: number) {
    const workspace = ref.current?.closest<HTMLElement>(
      "[data-resize-workspace]"
    )
    if (!workspace) return
    const max = Math.max(minWidth, Math.floor(workspace.clientWidth * maxRatio))
    const next = Math.round(Math.max(minWidth, Math.min(max, value)))
    // Animate toggling the tree, but apply pointer and keyboard resizing immediately.
    workspace.dataset.resizing = "true"
    workspace.getBoundingClientRect()
    workspace.style.setProperty(property, `${next}px`)
    workspace.getBoundingClientRect()
    delete workspace.dataset.resizing
  }

  function remember() {
    const value = (
      panelRef?.current ?? ref.current?.parentElement
    )?.getBoundingClientRect().width
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
      className={cn(
        "absolute inset-y-0 z-40 w-2 cursor-col-resize touch-none select-none before:absolute before:inset-y-0 before:left-1/2 before:w-px hover:before:bg-primary focus-visible:outline-2 focus-visible:outline-primary active:before:bg-primary",
        edge === "left" ? "-left-1" : "-right-1"
      )}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.currentTarget.focus()
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = {
          x: event.clientX,
          width: (
            panelRef?.current ?? event.currentTarget.parentElement!
          ).getBoundingClientRect().width,
        }
      }}
      onPointerMove={(event) => {
        if (drag.current)
          resize(
            drag.current.width + direction * (event.clientX - drag.current.x)
          )
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
        const current = (
          panelRef?.current ?? event.currentTarget.parentElement!
        ).getBoundingClientRect().width
        const step = event.shiftKey ? 40 : 10
        const next =
          event.key === "ArrowLeft"
            ? current - step * direction
            : event.key === "ArrowRight"
              ? current + step * direction
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
