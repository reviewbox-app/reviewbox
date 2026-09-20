import { resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const config = await Bun.file(resolve(root, "src-tauri/tauri.conf.json")).json()
const validationConfig = {
  app: {
    windows: config.app.windows.map((window: { label: string }) => ({
      ...window,
      ...(window.label === "main" ? { url: "dev/index.html" } : {}),
    })),
  },
}

const child = Bun.spawn(
  [
    "bun",
    "run",
    "tauri",
    "build",
    "--debug",
    "--config",
    JSON.stringify(validationConfig),
  ],
  {
    cwd: root,
    env: { ...process.env, REVIEWBOX_DEVTOOLS: "1" },
    stdout: "inherit",
    stderr: "inherit",
  }
)

process.exit(await child.exited)
