"use client"

import { useCallback } from "react"

/** Masks the scroll viewport, keeping the first and last rows opaque at rest. */
export function useScrollEdgeMask<T extends HTMLElement>() {
  return useCallback((viewport: T | null) => {
    if (!viewport) return

    let previous = ""
    const update = () => {
      const remaining = Math.max(
        0,
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop
      )
      const top = Math.min(16, Math.max(0, viewport.scrollTop))
      const bottom = remaining <= 1 ? 0 : Math.min(16, remaining)
      const mask =
        top || bottom
          ? `linear-gradient(to bottom, transparent, #000 ${top}px, #000 calc(100% - ${bottom}px), transparent)`
          : "none"
      if (mask === previous) return
      previous = mask
      viewport.style.maskImage = mask
      viewport.style.setProperty("-webkit-mask-image", mask)
    }
    const resize = new ResizeObserver(update)
    const observeContent = () => {
      resize.disconnect()
      resize.observe(viewport)
      for (const child of viewport.children) resize.observe(child)
      update()
    }
    const content = new MutationObserver(observeContent)
    content.observe(viewport, {
      childList: true,
      subtree: true,
      characterData: true,
    })
    viewport.addEventListener("scroll", update, { passive: true })
    observeContent()

    return () => {
      viewport.removeEventListener("scroll", update)
      resize.disconnect()
      content.disconnect()
      viewport.style.removeProperty("mask-image")
      viewport.style.removeProperty("-webkit-mask-image")
    }
  }, [])
}
