import type {
  EditorEntry,
  EditorSearchBuffer,
  EditorSearchResult,
  RepositoryReadChange,
} from "@/lib/desktop/contracts.generated"
import { errorMessage } from "@/lib/desktop/review.commands"
import { editorCommands } from "./editor.commands"

export interface EditorSearchSnapshot {
  result?: EditorSearchResult
  error?: string
  pending: boolean
}
const order = (
  a: EditorSearchResult["matches"][number],
  b: EditorSearchResult["matches"][number]
) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column
const affected = (path: string, paths: string[]) =>
  paths.some((changed) => path === changed || path.startsWith(changed + "/"))

/** Directory exclusion is independent of expansion and of ignored-only descendants. */
export function searchablePaths(paths: string[], entries: EditorEntry[]) {
  const ignoredFiles = new Set(
    entries
      .filter((entry) => !entry.directory && entry.ignored)
      .map((entry) => entry.path)
  )
  const ignoredTrees = entries
    .filter((entry) => entry.directory && (entry.excluded ?? entry.lazy))
    .map((entry) => entry.path)
  return paths.filter(
    (path) => !ignoredFiles.has(path) && !affected(path, ignoredTrees)
  )
}

/** Undefined means reconcile all; an empty list means this event is irrelevant. */
export function searchRefreshPaths(
  change: RepositoryReadChange,
  entries: EditorEntry[]
): string[] | undefined {
  if (
    change.full ||
    (change.git && change.tree) ||
    change.paths.some((path) => /(^|\/)(\.gitignore|\.ignore)$/.test(path))
  )
    return undefined
  return searchablePaths(change.paths, entries)
}

/** Owns cancellation, ordered partial results and dirty-path refreshes independently of React. */
export function createEditorSearch({
  repositoryId,
  query,
  owner,
  initial,
  buffers,
  publish,
  transport = editorCommands,
  delay = 200,
}: {
  repositoryId: string
  query: string
  owner: string
  initial?: EditorSearchResult
  buffers: () => EditorSearchBuffer[]
  publish: (snapshot: EditorSearchSnapshot) => void
  transport?: Pick<typeof editorCommands, "search" | "cancelSearch">
  delay?: number
}) {
  let disposed = false
  let currentRequest = ""
  let timer: ReturnType<typeof setTimeout> | undefined
  let complete = !!initial
  let active = false
  let activePaths: string[] | undefined
  let all = true
  const pendingPaths = new Set<string>()
  let result = initial
  const report = (pending: boolean, error?: string) =>
    publish({ result, pending, error })
  const cancel = () => {
    if (currentRequest)
      void transport
        .cancelSearch(currentRequest, owner, repositoryId)
        .catch(() => {})
    currentRequest = ""
    active = false
  }
  const start = (paths?: string[]) => {
    if (disposed) return
    const requestId = crypto.randomUUID()
    currentRequest = requestId
    active = true
    activePaths = paths
    let lastSequence = 0
    const retained = paths
      ? (result?.matches.filter((match) => !affected(match.path, paths)) ?? [])
      : []
    const streamed: EditorSearchResult["matches"] = []
    const relevant = () => !disposed && currentRequest === requestId
    const wasTruncated = !!paths && !!result?.truncated
    const merged = (next: EditorSearchResult): EditorSearchResult => {
      const matches = [...retained, ...next.matches].sort(order)
      return {
        ...next,
        matches: matches.slice(0, 1000),
        truncated: next.truncated || matches.length > 1000 || wasTruncated,
      }
    }
    report(true)
    void transport
      .search(
        repositoryId,
        query,
        requestId,
        owner,
        buffers(),
        paths,
        (batch) => {
          if (
            !relevant() ||
            batch.requestId !== requestId ||
            batch.sequence <= lastSequence
          )
            return
          lastSequence = batch.sequence
          streamed.push(...batch.matches)
          result = merged({
            requestId,
            matches: streamed,
            truncated: false,
            cancelled: false,
            scannedFiles: 0,
            skippedFiles: 0,
          })
          report(true)
        }
      )
      .then((next) => {
        if (!relevant()) return
        currentRequest = ""
        active = false
        if (!next.cancelled) {
          result = merged(next)
          complete = true
        }
        result ??= next
        report(false)
      })
      .catch((error) => {
        if (relevant()) {
          currentRequest = ""
          active = false
          report(false, errorMessage(error))
        }
      })
  }
  return {
    refresh(paths?: string[]) {
      if (disposed) return
      // A partial request interrupted by a second change must requeue its own paths too.
      if (active) {
        if (!activePaths) all = true
        else for (const path of activePaths) pendingPaths.add(path)
      }
      if (!paths || !complete) all = true
      else for (const path of paths) pendingPaths.add(path)
      cancel()
      clearTimeout(timer)
      report(true)
      timer = setTimeout(() => {
        const paths =
          all || pendingPaths.size > 512 ? undefined : [...pendingPaths]
        all = false
        pendingPaths.clear()
        start(paths)
      }, delay)
    },
    dispose() {
      disposed = true
      cancel()
      clearTimeout(timer)
    },
  }
}
