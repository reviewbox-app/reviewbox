import { copyFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const output = await mkdtemp(join(tmpdir(), "reviewbox-app-icons-"))
try {
  const process = Bun.spawn(
    [
      "bun",
      "run",
      "tauri",
      "icon",
      "resources/branding/reviewbox.svg",
      "--output",
      output,
    ],
    { cwd: root, stdout: "inherit", stderr: "inherit" }
  )
  if ((await process.exited) !== 0)
    throw new Error("App icon generation failed")
  // Keep the desktop assets only; the CLI also produces mobile/store variants.
  for (const name of [
    "32x32.png",
    "128x128.png",
    "128x128@2x.png",
    "icon.png",
    "icon.icns",
    "icon.ico",
  ]) {
    await copyFile(join(output, name), join(root, "src-tauri/icons", name))
  }
} finally {
  await rm(output, { recursive: true, force: true })
}
