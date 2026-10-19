import { buildTree, type Folder } from "./tree.helpers"

export type FileGroup = { path: string; paths: string[] }

/** Choose boundaries from the complete changed-file inventory, never a filter. */
export function groupFiles(paths: readonly string[]): FileGroup[] {
  const unique = [...new Set(paths)].filter((path) => !path.endsWith("/"))
  const tree = buildTree(unique.sort())
  const inventory = new Map<Folder, string[]>()
  const collect = (node: Folder): string[] => {
    const files = [
      ...node.files,
      ...[...node.folders.values()].flatMap(collect),
    ].sort()
    inventory.set(node, files)
    return files
  }
  collect(tree)
  const groups: FileGroup[] = []
  const visit = (node: Folder) => {
    const children = [...node.folders.values()]
    const files = inventory.get(node)!
    if (!files.length) return
    // Collapse common containers such as src/features, irrespective of their names.
    if (!node.files.length && children.length === 1) return visit(children[0])
    const substantial = children.filter(
      (child) => inventory.get(child)!.length >= 3
    )
    const split =
      children.length > 0 &&
      (!node.path ||
        files.length > 12 ||
        (!node.files.length && substantial.length >= 2))
    if (!split) {
      groups.push({ path: node.path, paths: files })
      return
    }
    const loose = [...node.files]
    for (const child of children) {
      const descendants = inventory.get(child)!
      // Only isolated files join the parent; a pair deserves its own group.
      if (descendants.length < 2) loose.push(...descendants)
      else visit(child)
    }
    if (loose.length) groups.push({ path: node.path, paths: loose.sort() })
  }
  visit(tree)
  return groups.sort((a, b) => a.path.localeCompare(b.path))
}
