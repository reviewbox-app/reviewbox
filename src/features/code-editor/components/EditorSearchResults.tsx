"use client"
import { HugeiconsIcon } from "@hugeicons/react"
import { RefreshIcon } from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import { useMemo } from "react"
import { FileIcon } from "@/features/file-icons/components/FileIcon"
import type {
  EditorSearchMatch,
  EditorSearchResult,
} from "@/lib/desktop/contracts.generated"

export function EditorSearchResults({
  result,
  pending,
  error,
  onSelect,
  refresh,
}: {
  result?: EditorSearchResult
  refresh: () => void
  pending: boolean
  error?: string
  onSelect: (match: EditorSearchMatch) => void
}) {
  const groups = useMemo(() => {
    const files = new Map<string, EditorSearchMatch[]>()
    for (const match of result?.matches ?? []) {
      const matches = files.get(match.path) ?? []
      matches.push(match)
      files.set(match.path, matches)
    }
    return [...files]
  }, [result])
  return (
    <div aria-label="Content search results" aria-busy={pending}>
      <div className="flex items-center justify-between gap-1">
        <p
          role={error ? "alert" : "status"}
          className="px-2 py-1 text-xs text-muted-foreground"
        >
          {error ||
            (pending
              ? "Searching…"
              : result?.cancelled
                ? "Search cancelled. Refresh to try again."
                : `${result?.matches.length ?? 0} matches in ${groups.length} files`)}
        </p>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Refresh content search"
          title="Refresh content search"
          disabled={pending}
          onClick={refresh}
        >
          <HugeiconsIcon icon={RefreshIcon} size={14} />
        </Button>
      </div>
      <p className="px-2 pb-2 text-xs text-muted-foreground">
        Searches saved files · ignored files excluded
      </p>
      {result?.truncated && (
        <p role="status" className="px-2 pb-2 text-xs text-muted-foreground">
          Search limit reached. Refine your search for more results.
        </p>
      )}
      {!!result?.skippedFiles && (
        <p className="px-2 pb-2 text-xs text-muted-foreground">
          {result.skippedFiles} files skipped (size, encoding or access).
        </p>
      )}
      <ul>
        {groups.map(([path, matches]) => (
          <li key={path} className="mb-2">
            <button
              title={path}
              onClick={() => onSelect(matches[0])}
              className="flex w-full items-center gap-2 rounded-xl px-2 py-1 text-left text-xs hover:bg-accent/60"
            >
              <FileIcon path={path} />
              <span className="min-w-0 flex-1 truncate">{path}</span>
              <span className="text-muted-foreground">{matches.length}</span>
            </button>
            <ul>
              {matches.map((match) => (
                <li key={`${match.line}:${match.column}`}>
                  <button
                    aria-label={`${path}:${match.line}:${match.column} ${match.preview}`}
                    title={match.preview}
                    onClick={() => onSelect(match)}
                    className="flex w-full gap-2 overflow-hidden rounded-xl py-1 pr-2 pl-6 text-left font-mono text-xs hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="shrink-0 text-muted-foreground">
                      {match.line}
                    </span>
                    <span className="truncate whitespace-pre">
                      {match.preview.slice(0, match.previewColumn - 1)}
                      <mark className="rounded-sm bg-primary/20 text-foreground">
                        {match.preview.slice(
                          match.previewColumn - 1,
                          match.previewColumn - 1 + match.length
                        )}
                      </mark>
                      {match.preview.slice(
                        match.previewColumn - 1 + match.length
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  )
}
