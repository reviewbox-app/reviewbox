import { defineReviewboxThemes } from "./reviewboxThemes"

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
      import("monaco-editor"),
      import("@monaco-editor/react"),
    ])

    loader.config({ monaco })
    defineReviewboxThemes(monaco)
  })().catch((error: unknown) => {
    initialization = undefined
    throw error
  })

  return initialization
}
