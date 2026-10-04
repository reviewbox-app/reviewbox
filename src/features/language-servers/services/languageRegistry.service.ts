import { create } from "zustand"
import { listen } from "@tauri-apps/api/event"
import { call, desktopAvailable } from "@/lib/desktop/review.commands"
import type {
  LanguagePack,
  LanguageRegistry,
} from "@/lib/desktop/contracts.generated"
import { configureCodeLanguages } from "@/lib/code/languages"
import { configureCustomGrammars } from "@/lib/code/highlighter"
import type { LanguageRegistration } from "shiki"

export const useLanguageRegistry = create<{
  registry: LanguageRegistry | null
  error: string
}>(() => ({ registry: null, error: "" }))
export const registryCommands = {
  read: () => call<LanguageRegistry>("language_registry"),
  save: (pack: LanguagePack) =>
    call<LanguageRegistry>("save_language_pack", { pack }),
  remove: (packId: string) =>
    call<LanguageRegistry>("remove_language_pack", { packId }),
}
export async function refreshLanguageRegistry() {
  const registry = await registryCommands.read()
  configureCodeLanguages(registry.languages)
  configureCustomGrammars(
    registry.packs
      .filter((p) => p.enabled)
      .flatMap((p) => p.grammars) as unknown as LanguageRegistration[]
  )
  const monaco = await import("monaco-editor/editor/editor.api")
  const registered = new Set(monaco.languages.getLanguages().map((l) => l.id))
  for (const language of registry.languages)
    if (!registered.has(language.id)) {
      monaco.languages.register({
        id: language.id,
        extensions: language.extensions.map((e) => `.${e}`),
        filenames: language.filenames,
        aliases: [language.name, ...language.aliases],
      })
    }
  useLanguageRegistry.setState({ registry, error: "" })
}
export function observeLanguageRegistry() {
  if (!desktopAvailable()) return () => {}
  const refresh = () =>
    void refreshLanguageRegistry().catch((e) =>
      useLanguageRegistry.setState({
        error: e instanceof Error ? e.message : String(e?.message ?? e),
      })
    )
  refresh()
  const listener = listen("reviewbox:language-packs-changed", refresh)
  return () => {
    void listener.then((stop) => stop())
  }
}
