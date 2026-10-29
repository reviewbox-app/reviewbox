"use client"
import { useCallback, useEffect, useLayoutEffect, useRef } from "react"
import {
  emptyTree,
  flushTreeNavigation,
  loadTreeNavigation,
  updateTreeNavigation,
  useTreeNavigation,
} from "../services/navigation.service"

const fallback = emptyTree()
/** Search expansion and scroll are transient; the durable state stays untouched. */
export function useFileTreeNavigation(
  repositoryId: string,
  key: string,
  searching = false
) {
  const checkout = useTreeNavigation((s) => s.checkouts[repositoryId])
  const value = checkout?.trees[key] ?? fallback
  const viewport = useRef<HTMLElement | null>(null)
  const current = useRef({ value, searching, ready: !!checkout })
  useLayoutEffect(() => {
    current.current = { value, searching, ready: !!checkout }
  }, [value, searching, checkout])
  const pendingRestore = useRef(true)
  const previousSearch = useRef(searching)
  const observer = useRef<MutationObserver | null>(null)
  const restore = useCallback(() => {
    const node = viewport.current
    const state = current.current
    if (!node || !state.ready || state.searching || !pendingRestore.current)
      return
    node.scrollTop = state.value.scrollTop
    // Inventory arrives asynchronously. Keep waiting until the tree can scroll.
    if (state.value.scrollTop === 0 || node.scrollHeight > node.clientHeight)
      pendingRestore.current = false
  }, [])
  const ref = useCallback(
    (node: HTMLElement | null) => {
      observer.current?.disconnect()
      viewport.current = node
      pendingRestore.current = true
      if (node) {
        observer.current = new MutationObserver(restore)
        observer.current.observe(node, { childList: true, subtree: true })
        restore()
      }
    },
    [restore]
  )
  useEffect(() => {
    if (repositoryId) void loadTreeNavigation(repositoryId).catch(() => {})
    return () => {
      if (repositoryId) void flushTreeNavigation(repositoryId).catch(() => {})
    }
  }, [repositoryId])
  useLayoutEffect(() => {
    pendingRestore.current = true
    restore()
  }, [repositoryId, key, restore])
  useLayoutEffect(() => {
    if (previousSearch.current && !searching) pendingRestore.current = true
    previousSearch.current = searching
    restore()
  }, [checkout, searching, restore])
  useEffect(() => () => observer.current?.disconnect(), [])
  return {
    value,
    ready: !!checkout,
    ref,
    onScroll: () => {
      if (!searching && !pendingRestore.current && viewport.current) {
        const scrollTop = viewport.current.scrollTop
        if (scrollTop !== current.current.value.scrollTop)
          updateTreeNavigation(repositoryId, key, (tree) => ({
            ...tree,
            scrollTop,
          }))
      }
    },
    update: (update: Parameters<typeof updateTreeNavigation>[2]) =>
      updateTreeNavigation(repositoryId, key, update),
    toggle: (path: string) =>
      updateTreeNavigation(repositoryId, key, (tree) => ({
        ...tree,
        expandedPaths: tree.expandedPaths.includes(path)
          ? tree.expandedPaths.filter((p) => p !== path)
          : [...tree.expandedPaths, path],
      })),
  }
}
