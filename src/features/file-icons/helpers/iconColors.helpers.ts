import chroma from "chroma-js"
import { materialPalette } from "./materialPalette"

// Color mapping follows Material Icon Theme 5.38.1 (MIT, Material Extensions).
// All SVG input is from the pinned, bundled package, never imported user markup.
const palette = Object.values(materialPalette)
export const isIconColor = (value: string) =>
  chroma.valid(materialPalette[value] ?? value)
const colorPattern = /(\b(?:fill|stroke|stop-color)=")([^"<>]+)(")/gi
const stylePattern =
  /((?<![\w-])(?:fill|stroke|stop-color)\s*:\s*)([^;}"<>]+)/gi
const protectedPattern =
  /<([\w:-]+)\b[^>]*data-mit-no-recolor="true"[^>]*(?:\/>|>[\s\S]*?<\/\1>)/gi

const closestColor = (color: string) => {
  let distance = Infinity
  let closest = palette[0]
  for (const candidate of palette) {
    const next = chroma.deltaE(candidate, color)
    if (next < distance) {
      distance = next
      closest = candidate
    }
  }
  return closest
}

/** Preserve the relative shades of multi-color icons instead of flattening them. */
export function recolorIcon(svg: string, requested: string): string {
  const base = materialPalette[requested] ?? requested
  if (!chroma.valid(base))
    throw new Error(`Unknown Material icon color: ${requested}`)
  const protectedParts: string[] = []
  const content = svg.replace(protectedPattern, (part) => {
    protectedParts.push(part)
    return `<!--reviewbox-icon-${protectedParts.length - 1}-->`
  })
  const colors = [
    ...new Set(
      [...content.matchAll(colorPattern), ...content.matchAll(stylePattern)]
        .map((match) => match[2])
        .filter((color) => chroma.valid(color))
    ),
  ].sort((a, b) => chroma(a).get("hsl.l") - chroma(b).get("hsl.l"))
  const replacements = new Map<string, string>()
  if (colors.length) replacements.set(colors[0], chroma(base).hex())
  const baseColor = chroma(base)
  let previous = baseColor
  for (const color of colors.slice(1)) {
    let next = chroma(color).set("hsl.h", baseColor.get("hsl.h"))
    if (colors.length === 2) next = next.set("hsl.s", baseColor.get("hsl.s"))
    if (next.luminance() < previous.luminance())
      next = next.set("hsl.l", previous.get("hsl.l") + 0.1)
    const closest = closestColor(next.hex())
    replacements.set(color, closest)
    previous = chroma(closest)
  }
  return content
    .replace(
      colorPattern,
      (_, prefix: string, color: string, suffix: string) =>
        `${prefix}${replacements.get(color) ?? color}${suffix}`
    )
    .replace(
      stylePattern,
      (_, prefix: string, color: string) =>
        `${prefix}${replacements.get(color.trim()) ?? color}`
    )
    .replace(
      /<!--reviewbox-icon-(\d+)-->/g,
      (_, index: string) => protectedParts[Number(index)]
    )
}

const imageCache = new Map<string, Promise<string>>()

export function coloredIconUrl(
  assetPath: string,
  color: string
): Promise<string> {
  const key = `${assetPath}|${color}`
  const cached = imageCache.get(key)
  if (cached) return cached
  const pending = fetch(assetPath)
    .then(async (response) => {
      if (!response.ok) throw new Error("File icon unavailable")
      const svg = recolorIcon(await response.text(), color)
      return `data:image/svg+xml,${encodeURIComponent(svg)}`
    })
    .catch((cause: unknown) => {
      imageCache.delete(key)
      throw cause
    })
  // Each item is a small SVG, and imported settings have a bounded number of clones.
  if (imageCache.size >= 256) imageCache.delete(imageCache.keys().next().value!)
  imageCache.set(key, pending)
  return pending
}
