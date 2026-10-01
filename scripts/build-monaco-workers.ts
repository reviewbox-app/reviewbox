import { build } from "bun"
import { fileURLToPath } from "node:url"

const workerEntries = {
  editor: "monaco-editor/editor/editor.worker.js",
  json: "monaco-editor/languages/features/json/json.worker.js",
  css: "monaco-editor/languages/features/css/css.worker.js",
  html: "monaco-editor/languages/features/html/html.worker.js",
  typescript: "monaco-editor/languages/features/typescript/ts.worker.js",
  "document-diff": "../src/features/markdown/workers/documentDiff.worker.ts",
} as const

const outdir = fileURLToPath(new URL("../public/monaco/", import.meta.url))

await Promise.all(
  Object.entries(workerEntries).map(async ([name, entry]) => {
    const result = await build({
      entrypoints: [fileURLToPath(import.meta.resolve(entry))],
      outdir,
      naming: `${name}.worker.js`,
      target: "browser",
      // Markdown entity decoding has separate DOM and worker entrypoints.
      conditions: ["worker"],
      format: "esm",
      minify: true,
      splitting: false,
    })

    if (!result.success) {
      throw new AggregateError(result.logs, `Failed to build ${name} worker`)
    }
  })
)

console.info("Built Monaco workers in public/monaco")
