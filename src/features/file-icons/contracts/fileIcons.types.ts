import type { Manifest } from "material-icon-theme"

export interface IconClone {
  name: string
  base: string
  color: string | null
  lightColor: string | null
  fileNames: string[]
  fileExtensions: string[]
  folderNames: string[]
  rootFolderNames: string[]
  activeForPacks: string[]
}

export interface FileIconPreferences {
  activeIconPack: "default" | "nest"
  fileAssociations: Record<string, string>
  folderAssociations: Record<string, string>
  fileClones: IconClone[]
  folderClones: IconClone[]
}

export interface FileIconCatalog {
  version: string
  manifests: Record<FileIconPreferences["activeIconPack"], Manifest>
}

export interface ResolvedFileIcon {
  assetPath: string
  color?: string
}

export const defaultFileIconPreferences: FileIconPreferences = {
  activeIconPack: "default",
  fileAssociations: {},
  folderAssociations: {},
  fileClones: [],
  folderClones: [],
}
