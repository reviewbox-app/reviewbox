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
  // Collapse single-child chains ("src-tauri/src") like the prototype.
  const compact = (folder: Folder): Folder => {
    folder.folders.forEach((child, key) =>
      folder.folders.set(key, compact(child))
    )
    if (folder.name && folder.folders.size === 1 && folder.files.length === 0) {
      const only = [...folder.folders.values()][0]
      return { ...only, name: `${folder.name}/${only.name}` }
    }
    return folder
  }
  return compact(root)
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
