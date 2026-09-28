import type { LanguageServerCatalogueEntry } from "@/lib/desktop/contracts.generated"

export function activeInstallation(status?: string) {
  return status === "queued" || status === "installing"
}

export function recommendedServers(
  entries: LanguageServerCatalogueEntry[],
  paths: string[]
) {
  const names = paths.map((path) => path.split("/").at(-1)?.toLowerCase() ?? "")
  return new Set(
    entries
      .filter((entry) =>
        names.some(
          (name) =>
            entry.extensions.some(
              (extension) =>
                name === extension || name.endsWith(`.${extension}`)
            ) ||
            (entry.id === "docker" &&
              (name === "dockerfile" || name.startsWith("dockerfile."))) ||
            (entry.id === "ruby" && (name === "gemfile" || name === "rakefile"))
        )
      )
      .map((entry) => entry.id)
  )
}

export function capabilityLabels(entry: LanguageServerCatalogueEntry) {
  if (!entry.capabilities) return []
  return (
    [
      ["semanticTokens", "Semantic colors"],
      ["hover", "Hover"],
      ["definitions", "Definitions"],
      ["references", "References"],
      ["symbols", "Symbols"],
    ] as const
  )
    .filter(([key]) => entry.capabilities?.[key])
    .map(([, label]) => label)
}
