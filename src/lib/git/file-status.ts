import type { Snapshot } from "@/lib/desktop/contracts.generated"

export type GitFileStatus = "A" | "D" | "M" | "R" | "U"

/** Combine the captured layers, so a staged addition edited again stays added. */
export function capturedFileStatuses(changes: Snapshot["changes"]) {
  const files = new Map<string, Snapshot["changes"]>()
  for (const change of changes) {
    const layers = files.get(change.path) ?? []
    layers.push(change)
    files.set(change.path, layers)
  }
  const statuses = new Map<string, GitFileStatus>()
  for (const [path, changes] of files) {
    const layers = [...changes].sort((a, b) =>
      a.layer === b.layer ? 0 : a.layer === "staged" ? -1 : 1
    )
    const first = layers[0]
    const last = layers.at(-1)!
    const status = !last.after
      ? "D"
      : layers.some((change) => change.previousPath)
        ? "R"
        : !first.before
          ? first.untracked
            ? "U"
            : "A"
          : "M"
    statuses.set(path, status)
  }
  return Object.fromEntries(statuses)
}

/** Aggregate all descendants, including files hidden by filtering or collapsed folders.
 * Prioritize added/untracked, then edited/renamed, then deleted. */
export function folderGitStatuses(files: Record<string, GitFileStatus>) {
  const folders = new Map<string, GitFileStatus>()
  const priority = { A: 3, U: 3, M: 2, R: 2, D: 1 }
  for (const [path, fileStatus] of Object.entries(files)) {
    const status =
      fileStatus === "U" ? "A" : fileStatus === "R" ? "M" : fileStatus
    const parts = path.split("/").slice(0, -1)
    for (let length = 1; length <= parts.length; length++) {
      const folder = parts.slice(0, length).join("/")
      const previous = folders.get(folder)
      folders.set(
        folder,
        previous && priority[previous] >= priority[status] ? previous : status
      )
    }
  }
  return Object.fromEntries(folders)
}
