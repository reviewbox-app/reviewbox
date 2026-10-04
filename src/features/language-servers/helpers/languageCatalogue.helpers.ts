import type { LanguageServerCatalogueEntry } from "@/lib/desktop/contracts.generated"
import { resolveCodeLanguage } from "@/lib/code/languages"

export function activeInstallation(status?: string) {
  return status === "queued" || status === "installing"
}

export function recommendedServers(
  entries: LanguageServerCatalogueEntry[],
  paths: string[]
) {
  const languages = new Set(
    paths.map((path) => resolveCodeLanguage(path).lspId)
  )
  return new Set(
    entries
      .filter((entry) => entry.languages.some((id) => languages.has(id)))
      .map((entry) => entry.id)
  )
}

export function capabilityLabels(entry: LanguageServerCatalogueEntry) {
  if (entry.liveCapabilities)
    return [
      ["semanticTokensProvider", "Semantic colors"],
      ["completionProvider", "Completion"],
      ["hoverProvider", "Hover"],
      ["signatureHelpProvider", "Signatures"],
      ["definitionProvider", "Definitions"],
      ["referencesProvider", "References"],
      ["documentSymbolProvider", "File symbols"],
      ["workspaceSymbolProvider", "Project symbols"],
      ["diagnosticProvider", "Diagnostics"],
      ["documentFormattingProvider", "Formatting"],
      ["renameProvider", "Rename"],
      ["codeActionProvider", "Code actions"],
    ]
      .filter(([key]) => entry.liveCapabilities?.[key])
      .map(([, label]) => label)
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
