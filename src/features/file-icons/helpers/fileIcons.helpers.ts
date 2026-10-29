import type { Manifest } from "material-icon-theme"
import type {
  FileIconCatalog,
  FileIconPreferences,
  IconClone,
  ResolvedFileIcon,
} from "../contracts/fileIcons.types"

const nameOf = (path: string) =>
  path.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? ""
const indexes = new WeakMap<Record<string, string>, Map<string, string>>()
const lookup = (values: Record<string, string> | undefined, key: string) => {
  if (!values) return undefined
  let index = indexes.get(values)
  if (!index) {
    index = new Map(
      Object.entries(values).map(([name, icon]) => [name.toLowerCase(), icon])
    )
    indexes.set(values, index)
  }
  return index.get(key)
}
const exact = (names: string[], name: string) =>
  names.some((entry) => !entry.includes("*") && entry.toLowerCase() === name)
const active = (clone: IconClone, preferences: FileIconPreferences) =>
  clone.activeForPacks.length === 0 ||
  clone.activeForPacks.includes(
    preferences.activeIconPack === "default" ? "" : preferences.activeIconPack
  )

function resolveAsset(
  manifest: Manifest,
  name: string | undefined,
  light: boolean,
  color?: string | null
): ResolvedFileIcon | undefined {
  if (!name) return
  const variant = light && manifest.iconDefinitions?.[`${name}_light`]
  const definition = variant || manifest.iconDefinitions?.[name]
  if (!definition) return
  return { assetPath: definition.iconPath, ...(color ? { color } : {}) }
}

/** Only known bundled icon IDs are resolved; repository paths never become URLs. */
export function resolveFileIcon(
  catalog: FileIconCatalog,
  preferences: FileIconPreferences,
  path: string,
  light: boolean,
  languageId?: string
): ResolvedFileIcon | undefined {
  const manifest = catalog.manifests[preferences.activeIconPack]
  const themed = light ? manifest.light : undefined
  const name = nameOf(path)
  const clones = preferences.fileClones.filter((clone) =>
    active(clone, preferences)
  )
  const custom = (id: string | undefined) => {
    const clone = clones.findLast((item) => item.name === id)
    return clone
      ? resolveAsset(
          manifest,
          clone.base,
          light,
          light ? (clone.lightColor ?? clone.color) : clone.color
        )
      : resolveAsset(manifest, id, light)
  }
  // **.ext deliberately overrides specific filenames, as in Material Icon Theme.
  const associations = Object.entries(preferences.fileAssociations).sort(
    ([a], [b]) => b.length - a.length
  )
  for (const [pattern, id] of associations) {
    if (
      pattern.startsWith("**.") &&
      name.endsWith(pattern.slice(2).toLowerCase())
    ) {
      const result = custom(id)
      if (result) return result
    }
  }
  const explicit = custom(lookup(preferences.fileAssociations, name))
  if (explicit) return explicit
  for (const clone of [...clones].reverse()) {
    if (exact(clone.fileNames, name)) {
      const result = custom(clone.name)
      if (result) return result
    }
  }
  const byName = custom(
    lookup(themed?.fileNames, name) ?? lookup(manifest.fileNames, name)
  )
  if (byName) return byName
  const suffixes = name
    .split(".")
    .slice(1)
    .map((_, index, parts) => parts.slice(index).join("."))
  for (const suffix of suffixes) {
    const associated = custom(
      lookup(preferences.fileAssociations, `*.${suffix}`)
    )
    if (associated) return associated
    for (const clone of [...clones].reverse()) {
      if (exact(clone.fileExtensions, suffix)) {
        const result = custom(clone.name)
        if (result) return result
      }
    }
    const result = custom(
      lookup(themed?.fileExtensions, suffix) ??
        lookup(manifest.fileExtensions, suffix)
    )
    if (result) return result
  }
  return custom(
    (languageId &&
      (lookup(themed?.languageIds, languageId) ??
        lookup(manifest.languageIds, languageId))) ||
      manifest.file
  )
}

export function resolveFolderIcon(
  catalog: FileIconCatalog,
  preferences: FileIconPreferences,
  path: string,
  light: boolean,
  open = false,
  root = false
): ResolvedFileIcon | undefined {
  const manifest = catalog.manifests[preferences.activeIconPack]
  const themed = light ? manifest.light : undefined
  const name = nameOf(path)
  const clones = preferences.folderClones.filter((clone) =>
    active(clone, preferences)
  )
  const custom = (id: string | undefined, expanded = false) => {
    const clone = clones.findLast((item) => item.name === id)
    let base = clone?.base ?? id
    if (base && !base.startsWith("folder")) base = `folder-${base}`
    if (base && expanded) base += "-open"
    return resolveAsset(
      manifest,
      base,
      light,
      clone
        ? light
          ? (clone.lightColor ?? clone.color)
          : clone.color
        : undefined
    )
  }
  const associated = custom(lookup(preferences.folderAssociations, name), open)
  if (associated) return associated
  for (const clone of [...clones].reverse()) {
    if (exact(root ? clone.rootFolderNames : clone.folderNames, name)) {
      const result = custom(clone.name, open)
      if (result) return result
    }
  }
  const key = root
    ? open
      ? "rootFolderNamesExpanded"
      : "rootFolderNames"
    : open
      ? "folderNamesExpanded"
      : "folderNames"
  const fallback = root
    ? open
      ? manifest.rootFolderExpanded
      : manifest.rootFolder
    : open
      ? manifest.folderExpanded
      : manifest.folder
  return custom(
    lookup(themed?.[key], name) ?? lookup(manifest[key], name) ?? fallback
  )
}
