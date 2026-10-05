import picomatch from "picomatch"

const methods: Record<string, string> = {
  completionProvider: "textDocument/completion",
  hoverProvider: "textDocument/hover",
  signatureHelpProvider: "textDocument/signatureHelp",
  definitionProvider: "textDocument/definition",
  referencesProvider: "textDocument/references",
  documentSymbolProvider: "textDocument/documentSymbol",
  documentFormattingProvider: "textDocument/formatting",
  renameProvider: "textDocument/rename",
  codeActionProvider: "textDocument/codeAction",
  semanticTokensProvider: "textDocument/semanticTokens",
  diagnosticProvider: "textDocument/diagnostic",
}
type Capabilities = Record<string, unknown>
type Filter = {
  language?: string
  scheme?: string
  pattern?: string | { baseUri: string | { uri: string }; pattern: string }
}
export function matchesDocument(
  selector: unknown,
  uri: string,
  language: string
) {
  if (selector == null) return true
  if (!Array.isArray(selector)) return false
  try {
    const resource = new URL(uri)
    const path = decodeURIComponent(resource.pathname)
    return (selector as Filter[]).some((filter) => {
      if (filter.language && filter.language !== language) return false
      if (filter.scheme && filter.scheme !== resource.protocol.slice(0, -1))
        return false
      if (!filter.pattern) return true
      let target = path
      let pattern = filter.pattern
      if (typeof pattern !== "string") {
        const base =
          typeof pattern.baseUri === "string"
            ? pattern.baseUri
            : pattern.baseUri.uri
        const prefix =
          decodeURIComponent(new URL(base).pathname).replace(/\/$/, "") + "/"
        if (!path.startsWith(prefix)) return false
        target = path.slice(prefix.length)
        pattern = pattern.pattern
      }
      return picomatch(pattern, { dot: true })(target)
    })
  } catch {
    return false
  }
}
export function documentCapability(
  capabilities: Capabilities | undefined,
  name: string,
  uri: string,
  language: string
): unknown {
  if (!capabilities) return undefined
  const registrations = capabilities.reviewboxRegistrations
  if (!Array.isArray(registrations) || !methods[name]) return capabilities[name]
  for (const registration of [...registrations].reverse()) {
    if (
      registration.method === methods[name] &&
      matchesDocument(
        registration.registerOptions?.documentSelector,
        uri,
        language
      )
    )
      return registration.registerOptions ?? true
  }
  return (
    capabilities.reviewboxStaticCapabilities as Capabilities | undefined
  )?.[name]
}
