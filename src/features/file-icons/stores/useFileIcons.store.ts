"use client"

import { create } from "zustand"
import {
  defaultFileIconPreferences,
  type FileIconCatalog,
  type FileIconPreferences,
} from "../contracts/fileIcons.types"

export const useFileIcons = create<{
  preferences: FileIconPreferences
  catalog: FileIconCatalog | null
}>(() => ({ preferences: defaultFileIconPreferences, catalog: null }))

let pending: Promise<void> | null = null
export function loadFileIcons() {
  if (!pending) {
    pending = fetch("/file-icons/catalog.json")
      .then((response) => {
        if (!response.ok) throw new Error("File icon catalog unavailable")
        return response.json() as Promise<FileIconCatalog>
      })
      .then((catalog) => {
        useFileIcons.setState({ catalog })
      })
      .catch(() => {
        pending = null
      })
  }
  return pending
}
