import { format, resolveConfig } from "prettier"
import { resolve } from "node:path"
const root = resolve(import.meta.dir, "..")
const result = Bun.spawnSync(
  [
    "cargo",
    "run",
    "--quiet",
    "--locked",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--example",
    "export_contracts",
  ],
  { cwd: root }
)
if (result.exitCode !== 0) {
  process.stderr.write(result.stderr)
  process.exit(result.exitCode)
}
const target = resolve(root, "src/lib/desktop/contracts.generated.ts")
const contents = await format(result.stdout.toString(), {
  ...(await resolveConfig(target)),
  filepath: target,
})
if (process.argv.includes("--check")) {
  if ((await Bun.file(target).text()) !== contents) {
    console.error("IPC contracts are stale. Run bun run contracts:generate.")
    process.exit(1)
  }
} else {
  await Bun.write(target, contents)
}
