import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { extensionProjects } from "../tests/native/extension-projects"

// Network access is needed only for the initial pinned engines and npm fixtures.
const temporary = !process.env.REVIEWBOX_EXTENSION_VALIDATION_DIR
const directory =
  process.env.REVIEWBOX_EXTENSION_VALIDATION_DIR ??
  (await mkdtemp(join(tmpdir(), "reviewbox-extensions-")))
process.env.REVIEWBOX_EXTENSION_FIXTURES = join(directory, "projects")
process.env.REVIEWBOX_LANGUAGE_SMOKE_DIR = join(directory, "appdata")
async function run(cmd: string[]) {
  const process = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" })
  if ((await process.exited) !== 0)
    throw new Error(`Validation failed: ${cmd.join(" ")}`)
}
try {
  extensionProjects(process.env.REVIEWBOX_EXTENSION_FIXTURES)
  await run(["bun", "run", "build:storage"])
  for (const test of [
    "real_extension_engines_edit_unsaved_projects",
    "prettier_respects_project_plugins_config_ignore_and_disable",
  ])
    await run([
      "cargo",
      "test",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--locked",
      "--lib",
      test,
      "--",
      "--ignored",
      "--nocapture",
    ])
  if (process.argv.includes("--native"))
    await run(["bun", "scripts/test-ui-editor-extensions.ts"])
} finally {
  await run(["bun", "run", "build:storage"])
  if (temporary) await rm(directory, { recursive: true, force: true })
}
