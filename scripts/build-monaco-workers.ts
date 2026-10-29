import { build } from "bun"
import { fileURLToPath } from "node:url"
import { copyFile, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"

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

// The model is distributed with the pinned package; packaged apps never fetch
// code, weights, or notices from a CDN. Keep the upstream runtime unchanged.
const detectionAssets = join(outdir, "language-detection")
await mkdir(detectionAssets, { recursive: true })
const packageRoot = dirname(
  fileURLToPath(
    import.meta.resolve("@vscode/vscode-languagedetection/package.json")
  )
)
for (const [source, target] of [
  ["dist/lib/index.js", "index.js"],
  ["dist/lib/979.js", "979.js"],
  ["model/model.json", "model.json"],
  ["model/group1-shard1of1.bin", "group1-shard1of1.bin"],
  ["LICENSE", "LICENSE"],
  ["dist/lib/index.js.LICENSE.txt", "index.js.LICENSE.txt"],
  ["dist/lib/979.js.LICENSE.txt", "979.js.LICENSE.txt"],
])
  await copyFile(join(packageRoot, source), join(detectionAssets, target))
const detectionWorker = await build({
  entrypoints: [
    fileURLToPath(
      new URL(
        "../src/features/language-servers/workers/languageDetection.worker.ts",
        import.meta.url
      )
    ),
  ],
  outdir,
  naming: "language-detection.worker.js",
  target: "browser",
  format: "iife",
  minify: true,
})
if (!detectionWorker.success)
  throw new AggregateError(
    detectionWorker.logs,
    "Failed to build language detection worker"
  )
console.info("Bundled local language detection model and notices")
