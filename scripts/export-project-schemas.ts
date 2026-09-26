import { format, resolveConfig } from "prettier"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
const root = resolve(import.meta.dir, "..")
const child = Bun.spawn(
  [
    "cargo",
    "run",
    "--quiet",
    "--locked",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--example",
    "export_project_schemas",
  ],
  { cwd: root, stdout: "pipe", stderr: "inherit" }
)
const result = await new Response(child.stdout).text()
if (await child.exited) throw new Error("Schema generation failed")
for (const [name, schema] of Object.entries(JSON.parse(result))) {
  const path = resolve(root, "resources/schemas", name)
  const text = await format(JSON.stringify(schema), {
    ...(await resolveConfig(path)),
    filepath: path,
  })
  if (process.argv.includes("--check")) {
    if ((await readFile(path, "utf8")) !== text)
      throw new Error(`Schema drift: ${name}`)
  } else {
    await mkdir(resolve(root, "resources/schemas"), { recursive: true })
    await writeFile(path, text)
  }
}
