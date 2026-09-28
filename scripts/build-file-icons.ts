import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, basename, resolve, join } from "node:path"
import { fileURLToPath } from "node:url"
import { generateManifest } from "material-icon-theme"

const packageRoot = dirname(
  fileURLToPath(import.meta.resolve("material-icon-theme/package.json"))
)
const output = fileURLToPath(new URL("../public/file-icons/", import.meta.url))
const manifests = {
  default: generateManifest({ activeIconPack: "" }),
  nest: generateManifest({ activeIconPack: "nest" }),
}
const copied = new Set<string>()
await mkdir(join(output, "icons"), { recursive: true })
for (const manifest of Object.values(manifests)) {
  for (const definition of Object.values(manifest.iconDefinitions ?? {})) {
    const name = basename(definition.iconPath)
    const source = resolve(packageRoot, "dist", definition.iconPath)
    if (!source.startsWith(`${join(packageRoot, "icons")}/`))
      throw new Error(`Unexpected Material icon asset: ${definition.iconPath}`)
    if (!copied.has(name)) {
      await copyFile(source, join(output, "icons", name))
      copied.add(name)
    }
    definition.iconPath = `/file-icons/icons/${name}`
  }
}
const { version } = JSON.parse(
  await readFile(join(packageRoot, "package.json"), "utf8")
) as { version: string }
await writeFile(
  join(output, "catalog.json"),
  JSON.stringify({ version, manifests })
)
await copyFile(join(packageRoot, "LICENSE"), join(output, "LICENSE.txt"))
console.info(`Built ${copied.size} Material file icons (${version})`)
