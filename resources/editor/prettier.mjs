import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { existsSync } from "node:fs"
import path from "node:path"

// Project plugins may log; stdout is reserved for the response protocol.
console.log = console.warn = (...args) => console.error(...args)
let input = ""
for await (const chunk of process.stdin) input += chunk
const { filepath, text, fallback, root, rangeStart, rangeEnd } =
  JSON.parse(input)
try {
  const projectRequire = createRequire(filepath)
  let entry
  try {
    entry = projectRequire.resolve("prettier")
  } catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") throw error
    entry = createRequire(path.join(fallback, "package.json")).resolve(
      "prettier"
    )
  }
  const imported = await import(pathToFileURL(entry).href)
  const prettier = imported.default ?? imported
  const configFile = await prettier.resolveConfigFile(filepath)
  const config =
    (await prettier.resolveConfig(filepath, { editorconfig: true })) ?? {}
  if (config.plugins) {
    const requirePlugin = createRequire(configFile ?? filepath)
    config.plugins = config.plugins.map((plugin) =>
      typeof plugin === "string" ? requirePlugin.resolve(plugin) : plugin
    )
  }
  let ignorePath
  for (
    let directory = path.dirname(filepath);
    directory.startsWith(root);
    directory = path.dirname(directory)
  ) {
    const candidate = path.join(directory, ".prettierignore")
    if (existsSync(candidate)) {
      ignorePath = candidate
      break
    }
    if (directory === root || path.dirname(directory) === directory) break
  }
  const info = await prettier.getFileInfo(filepath, {
    ignorePath,
    withNodeModules: false,
    plugins: config.plugins,
  })
  if (info.ignored || (!info.inferredParser && !config.parser)) {
    process.stdout.write(JSON.stringify({ text: null }))
  } else {
    const options = { ...config, filepath }
    if (rangeStart != null) options.rangeStart = rangeStart
    if (rangeEnd != null) options.rangeEnd = rangeEnd
    process.stdout.write(
      JSON.stringify({ text: await prettier.format(text, options) })
    )
  }
} catch (error) {
  process.stdout.write(
    JSON.stringify({ error: error.message ?? String(error) })
  )
  process.exitCode = 1
}
