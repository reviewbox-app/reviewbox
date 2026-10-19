import type { LocalFile } from "@/lib/desktop/contracts.generated"
import type { GitFileStatus } from "@/lib/git/file-status"

export function fullyStagedPaths(files: LocalFile[]) {
  const result = new Set(
    files
      .filter(
        (file) =>
          !!file.stagedStatus && !file.unstagedStatus && !file.conflicted
      )
      .map((file) => file.path)
  )
  const folders = new Map<string, string[]>()
  for (const file of files) {
    const parts = file.path.split("/").slice(0, -1)
    for (let i = 1; i <= parts.length; i++) {
      const folder = parts.slice(0, i).join("/")
      folders.set(folder, [...(folders.get(folder) ?? []), file.path])
    }
  }
  for (const [folder, children] of folders)
    if (children.every((path) => result.has(path))) result.add(folder)
  return result
}
export function localFileStatuses(
  files: LocalFile[],
  layer?: "staged" | "unstaged"
): Record<string, GitFileStatus> {
  return Object.fromEntries(
    files.map((file) => {
      const status =
        layer === "unstaged"
          ? file.unstagedStatus
          : layer === "staged"
            ? file.stagedStatus
            : (file.stagedStatus ?? file.unstagedStatus)
      return [
        file.path,
        ["A", "D", "R", "U"].includes(status ?? "") ? status : "M",
      ]
    })
  ) as Record<string, GitFileStatus>
}
export function availableLayer(file: LocalFile | undefined, preferred: string) {
  if (preferred === "staged" && file?.stagedStatus) return "staged"
  return file?.unstagedStatus ? "unstaged" : "staged"
}

/** A partial file belongs to both lists, each opening its own diff layer. */
export function localFileGroups(files: LocalFile[]) {
  return {
    unstaged: files.filter((file) => file.unstagedStatus || file.conflicted),
    staged: files.filter((file) => file.stagedStatus && !file.conflicted),
  }
}

/** Choose a neighbour in the displayed order, excluding the entire staged batch. */
export function nextLocalFile(
  order: string[],
  eligible: ReadonlySet<string>,
  current: string
) {
  const index = order.indexOf(current)
  return (
    order.slice(index + 1).find((path) => eligible.has(path)) ??
    order
      .slice(0, Math.max(0, index))
      .reverse()
      .find((path) => eligible.has(path))
  )
}

/** Resolve against the Git result, never the pre-mutation file statuses. */
export function nextLocalFileInLayer(
  order: string[],
  files: LocalFile[],
  current: string,
  layer: "staged" | "unstaged",
  excluded: ReadonlySet<string>
) {
  return nextLocalFile(
    order,
    new Set(
      files
        .filter(
          (file) =>
            !excluded.has(file.path) &&
            !file.conflicted &&
            (layer === "unstaged" ? file.unstagedStatus : file.stagedStatus)
        )
        .map((file) => file.path)
    ),
    current
  )
}
