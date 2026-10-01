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

/** A folder uses the shared status of its descendants, or M for mixed changes. */
export function folderGitStatuses(files: Record<string, GitFileStatus>) {
  const folders = new Map<string, GitFileStatus>()
  for (const [path, status] of Object.entries(files)) {
    const parts = path.split("/").slice(0, -1)
    for (let length = 1; length <= parts.length; length++) {
      const folder = parts.slice(0, length).join("/")
      const previous = folders.get(folder)
      folders.set(folder, previous && previous !== status ? "M" : status)
    }
  }
  return Object.fromEntries(folders)
}
