export interface Folder {
  name: string
  path: string
  folders: Map<string, Folder>
  files: string[]
}

export function buildTree(paths: string[]) {
  const root: Folder = { name: "", path: "", folders: new Map(), files: [] }
  for (const path of paths) {
    const parts = path.split("/")
    let node = root
    for (const part of parts.slice(0, -1)) {
      const next = node.path ? `${node.path}/${part}` : part
      if (!node.folders.has(part))
        node.folders.set(part, {
          name: part,
          path: next,
          folders: new Map(),
          files: [],
        })
      node = node.folders.get(part)!
    }
    if (!path.endsWith("/")) node.files.push(path)
  }
  return root
}

export function folderPaths(paths: string[]) {
  return [
    ...new Set(
      paths.flatMap((path) => {
        const parts = path.split("/")
        return parts
          .slice(0, -1)
          .map((_, index) => parts.slice(0, index + 1).join("/"))
      })
    ),
  ]
}

/** Depth-first order used by tree rows, including children of collapsed folders. */
export function orderedTreeFiles(paths: string[]): string[] {
  const visit = (folder: Folder): string[] => [
    ...[...folder.folders.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap(visit),
    ...folder.files,
  ]
  return visit(buildTree(paths))
}
