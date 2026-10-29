import { registerLanguageConfigurations } from "./languageConfigurations"
import { observeCodeEditors } from "@/lib/code/codeAppearance"
import { initializeCodeHighlighting } from "@/lib/code/highlighter"

let initialization: Promise<void> | undefined

function getWorkerName(label: string): string {
  switch (label) {
    case "json":
      return "json"
    case "css":
    case "scss":
    case "less":
      return "css"
    case "html":
    case "handlebars":
    case "razor":
      return "html"
    case "typescript":
    case "javascript":
      return "typescript"
    default:
      return "editor"
  }
}

/** Configure the local ESM instance before any React editor mounts. */
export function initializeMonaco(): Promise<void> {
  initialization ??= (async () => {
    self.MonacoEnvironment = {
      getWorker(_moduleId, label) {
        const url = new URL(
          `/monaco/${getWorkerName(label)}.worker.js`,
          window.location.href
        )

        return new Worker(url, { name: label, type: "module" })
      },
    }

    const [monaco, { loader }] = await Promise.all([
      import("monaco-editor/editor/editor.api"),
      import("@monaco-editor/react"),
    ])

    await import("monaco-editor/features/register.all")
    // 0.56's aggregate registers range tokens only; native servers also expose
    // full-document tokens, whose lifecycle feature must be registered explicitly.
    await import("monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens")
    loader.config({ monaco })
    await initializeCodeHighlighting(monaco)
    await registerLanguageConfigurations(monaco)
    observeCodeEditors(monaco)
  })().catch((error: unknown) => {
    initialization = undefined
    throw error
  })

  return initialization
}
