"use client"

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useLayoutEffect,
  useState,
  type ComponentProps,
} from "react"

type SearchRequest = { text: string; token: string }
const ExplorerSearch = createContext<{
  request?: SearchRequest
  search: (text: string) => void
} | null>(null)

/** Route editor selections to the surrounding explorer without changing its search mode. */
export function ExplorerSearchProvider({
  children,
  onReveal,
  ...container
}: ComponentProps<"div"> & {
  onReveal?: () => void
}) {
  const [request, setRequest] = useState<SearchRequest>()
  const reveal = useRef(onReveal)
  useLayoutEffect(() => {
    reveal.current = onReveal
  }, [onReveal])
  const search = useCallback((text: string) => {
    reveal.current?.()
    setRequest({ text, token: crypto.randomUUID() })
  }, [])
  return (
    <ExplorerSearch value={{ request, search }}>
      <div {...container}>{children}</div>
    </ExplorerSearch>
  )
}

export function useExplorerSearch() {
  return useContext(ExplorerSearch)
}
