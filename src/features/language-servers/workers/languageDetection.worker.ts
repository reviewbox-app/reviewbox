import type { ModelOperations } from "@vscode/vscode-languagedetection"
import { LANGUAGE_DETECTION_LIMIT } from "../helpers/languageDetection"

interface DetectorWorker {
  importScripts: (...urls: string[]) => void
  exports?: Record<string, unknown>
  require?: (path: string) => Record<string, unknown>
  "vscode-languagedetection"?: { ModelOperations: typeof ModelOperations }
  onmessage:
    ((event: MessageEvent<{ id: string; content: string }>) => void) | null
  postMessage: (message: unknown) => void
}
const scope = self as unknown as DetectorWorker
let model: ModelOperations | undefined
let queue = Promise.resolve()

async function asset(name: string) {
  const response = await fetch(`/monaco/language-detection/${name}`)
  if (!response.ok) throw new Error(`Language model asset unavailable: ${name}`)
  return response
}

function detector() {
  if (model) return model
  // Upstream distributes a UMD entry and one CommonJS CPU-backend chunk. This
  // adapter loads those unchanged local assets, without eval or Node access.
  scope.require = (path) => {
    if (path !== "./979.js")
      throw new Error(`Unsupported model module: ${path}`)
    const chunk: Record<string, unknown> = {}
    scope.exports = chunk
    try {
      scope.importScripts("/monaco/language-detection/979.js")
    } finally {
      delete scope.exports
    }
    return chunk
  }
  scope.importScripts("/monaco/language-detection/index.js")
  const library = scope["vscode-languagedetection"]
  if (!library) throw new Error("Language model could not be loaded")
  model = new library.ModelOperations({
    modelJsonLoaderFunc: async () => (await asset("model.json")).json(),
    weightsLoaderFunc: async () =>
      (await asset("group1-shard1of1.bin")).arrayBuffer(),
    minContentSize: 20,
    maxContentSize: LANGUAGE_DETECTION_LIMIT,
  })
  return model
}

scope.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    try {
      const candidates = await detector().runModel(
        data.content.slice(0, LANGUAGE_DETECTION_LIMIT)
      )
      scope.postMessage({ id: data.id, candidates })
    } catch (error) {
      scope.postMessage({
        id: data.id,
        error:
          error instanceof Error
            ? error.message
            : "Language detection unavailable",
      })
    }
  })
}
