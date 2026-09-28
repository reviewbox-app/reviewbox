"use client"

import { useEffect, useMemo, useState } from "react"
import { useTheme } from "next-themes"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  File01Icon,
  Folder01Icon,
  FolderOpenIcon,
} from "@hugeicons/core-free-icons"
import { cn } from "@/lib/utils"
import {
  resolveFileIcon,
  resolveFolderIcon,
} from "../helpers/fileIcons.helpers"
import { coloredIconUrl } from "../helpers/iconColors.helpers"
import { loadFileIcons, useFileIcons } from "../stores/useFileIcons.store"

interface IconProps {
  path: string
  className?: string
  size?: number
  languageId?: string
}

function MaterialIcon({
  path,
  size = 16,
  className,
  languageId,
  folder = false,
  open = false,
  root = false,
}: IconProps & { folder?: boolean; open?: boolean; root?: boolean }) {
  const preferences = useFileIcons((state) => state.preferences)
  const catalog = useFileIcons((state) => state.catalog)
  const { resolvedTheme } = useTheme()
  const light = resolvedTheme === "light"
  useEffect(() => {
    void loadFileIcons()
  }, [])
  const icon = useMemo(() => {
    if (!catalog) return undefined
    return folder
      ? resolveFolderIcon(catalog, preferences, path, light, open, root)
      : resolveFileIcon(catalog, preferences, path, light, languageId)
  }, [catalog, preferences, path, light, folder, open, root, languageId])
  const [colored, setColored] = useState<{ key: string; url: string } | null>(
    null
  )
  const [failed, setFailed] = useState<string | null>(null)
  const key = `${icon?.assetPath ?? ""}|${icon?.color ?? ""}`
  useEffect(() => {
    if (!icon?.color) return
    let active = true
    void coloredIconUrl(icon.assetPath, icon.color)
      .then((url) => {
        if (active) setColored({ key, url })
      })
      .catch(() => {
        /* The bundled base icon remains available. */
      })
    return () => {
      active = false
    }
  }, [icon, key])
  const src = colored?.key === key ? colored.url : icon?.assetPath
  if (!src || failed === src)
    return (
      <HugeiconsIcon
        icon={folder ? (open ? FolderOpenIcon : Folder01Icon) : File01Icon}
        size={size}
        aria-hidden
        className={cn("shrink-0 text-muted-foreground", className)}
      />
    )
  return (
    // Local SVGs are immutable assets; Next's image transformation is unnecessary.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      aria-hidden
      width={size}
      height={size}
      draggable={false}
      onError={() => setFailed(src)}
      className={cn("shrink-0 object-contain", className)}
      style={{ width: size, height: size }}
    />
  )
}

export function FileIcon(props: IconProps) {
  return <MaterialIcon {...props} />
}
export function FolderIcon(
  props: Omit<IconProps, "languageId"> & { open?: boolean; root?: boolean }
) {
  return <MaterialIcon {...props} folder />
}
