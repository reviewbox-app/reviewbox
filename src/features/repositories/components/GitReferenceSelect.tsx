"use client"
import { useEffect, useState } from "react"
import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox"
import type { RepositoryRef } from "@/lib/desktop/contracts.generated"
import { creationCommands } from "../services/creation.commands"
import { errorMessage } from "@/lib/desktop/review.commands"

/** Editable references keep arbitrary local revspecs available alongside the history. */
export function GitReferenceSelect({
  repositoryId,
  label,
  value,
  onChange,
}: {
  repositoryId: string
  label: string
  value: string
  onChange: (value: string) => void
}) {
  const [references, setReferences] = useState<RepositoryRef[]>([])
  const [query, setQuery] = useState(value)
  const [error, setError] = useState("")
  useEffect(() => {
    let alive = true
    const timer = setTimeout(() => {
      creationCommands
        .references(repositoryId, query)
        .then((items) => {
          if (alive) {
            setReferences(items)
            setError("")
          }
        })
        .catch((e) => {
          if (alive) setError(errorMessage(e))
        })
    }, 120)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [repositoryId, query])
  const items = [
    ...new Set([
      ...(query.trim() ? [query.trim()] : []),
      ...references.map((r) => r.name),
    ]),
  ]
  return (
    <div className="min-w-0 flex-1" onKeyDown={(e) => e.stopPropagation()}>
      <Combobox
        items={items}
        value={value}
        inputValue={query}
        filter={null}
        onInputValueChange={(text) => {
          setQuery(text)
          onChange(text)
        }}
        onValueChange={(next) => {
          if (next) {
            onChange(next)
            setQuery(next)
          }
        }}
      >
        <ComboboxInput aria-label={label} className="w-full min-w-0" />
        <ComboboxContent>
          <ComboboxList>
            {(item: string) => {
              const reference = references.find((r) => r.name === item)
              return (
                <ComboboxItem key={item} value={item} className="min-w-0">
                  <span className="min-w-0 truncate">
                    <span className="font-mono text-xs">{item}</span>
                    {reference?.summary && (
                      <span className="ml-1.5 text-xs text-muted-foreground">
                        · {reference.summary}
                      </span>
                    )}
                  </span>
                </ComboboxItem>
              )
            }}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      {error && (
        <p className="mt-1 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
