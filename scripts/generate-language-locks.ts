import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Explicit maintenance command. Packaged application installs only these locked trees.
const catalogue = (await Bun.file(
  "resources/languages/catalogue.json"
).json()) as {
  id: string
  method: string
  packages?: Record<string, string>
  overrides?: Record<string, string>
}[]
const locks: Record<string, unknown> = {}
for (const server of catalogue.filter((entry) => entry.method === "npm")) {
  const directory = await mkdtemp(join(tmpdir(), "reviewbox-lsp-lock-"))
  try {
    const manifest = {
      name: `reviewbox-lsp-${server.id}`,
      version: "1.0.0",
      private: true,
      dependencies: server.packages,
      overrides: server.overrides,
    }
    await writeFile(join(directory, "package.json"), JSON.stringify(manifest))
    const process = Bun.spawn(
      [
        "npm",
        "install",
        "--package-lock-only",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--registry=https://registry.npmjs.org",
      ],
      { cwd: directory, stdout: "pipe", stderr: "pipe" }
    )
    const [status, output] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
    ])
    if (status !== 0) throw new Error(`Locking ${server.id}: ${output}`)
    locks[server.id] = JSON.parse(
      await readFile(join(directory, "package-lock.json"), "utf8")
    )
    console.info(`Locked ${server.id}`)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
await writeFile(
  "resources/languages/npm-locks.json",
  JSON.stringify(locks, null, 2) + "\n"
)
