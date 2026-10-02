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
