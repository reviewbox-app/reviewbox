import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import {
  cacheCandidates,
  gib,
  overBudget,
  pruneCaches,
  storageReport,
} from "./build-storage"

const root = await realpath(resolve(import.meta.dir, ".."))
const lock = resolve(root, ".reviewbox-build-lock")
const [mode, ...args] = process.argv.slice(2)

async function report() {
  const result = await storageReport(root)
  for (const item of result.directories)
    console.log(`${item.path}: ${gib(item.bytes)}`)
  console.log(
    `Artifacts: ${gib(result.total)} / 20 GiB; free disk: ${gib(result.free)} (minimum 10 GiB).`
  )
  return result
}

async function idle() {
  // Conservative across projects: never delete Rust caches while a compiler is active.
  const windows = process.platform === "win32"
  const result = Bun.spawnSync(
    windows ? ["tasklist", "/FO", "CSV", "/NH"] : ["ps", "-axo", "comm="],
    { stdout: "pipe", stderr: "pipe" }
  )
  if (result.exitCode !== 0)
    throw new Error(
      "Cannot verify whether Cargo is idle; no caches were removed."
    )
  if (
    result.stdout
      .toString()
      .split("\n")
      .some((line) =>
        (windows
          ? /^"(?:cargo|rustc|rustdoc)\.exe"/i
          : /(?:^|\/)(?:cargo|rustc|rustdoc)(?:\s|$)/
        ).test(line.trim())
      )
  )
    throw new Error(
      "Cargo/rustc is running. Wait for it to finish before cache cleanup."
    )
}

async function prune(compiled = false) {
  await idle()
  console.log(
    `Removed ${gib(await pruneCaches(root, compiled))} of recreatable Rust caches.`
  )
}

async function enforce() {
  let current = await report()
  if (overBudget(current)) {
    await prune()
    current = await report()
  }
  if (overBudget(current))
    throw new Error(
      "Build storage limit reached. Inspect with bun run build:storage. Once native tests and installation verification are finished, use bun run build:clean --apply --compiled, then check again. No bundles or app data are removed by that command."
    )
}

async function run(command: string[], env: NodeJS.ProcessEnv = process.env) {
  const child = Bun.spawn(command, {
    cwd: root,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  const interrupt = () => child.kill("SIGINT")
  const terminate = () => child.kill("SIGTERM")
  process.on("SIGINT", interrupt)
  process.on("SIGTERM", terminate)
  try {
    return await child.exited
  } finally {
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", terminate)
  }
}

async function build(env: NodeJS.ProcessEnv) {
  if (mode === "tauri")
    return run(
      ["bun", "--bun", "node_modules/@tauri-apps/cli/tauri.js", ...args],
      env
    )
  for (const command of [
    ["bun", "run", "icons:build"],
    ["bun", "run", "workers:build"],
    ["bun", "--bun", "next", "build", ...args],
  ]) {
    const code = await run(command, env)
    if (code) return code
  }
  return 0
}

async function main() {
  if (mode === "report") {
    await report()
    return 0
  }
  if (
    mode === "tauri" &&
    (args[0] !== "build" || args.includes("--help") || args.includes("-h"))
  )
    return build(process.env)
  if (!["tauri", "web", "clean"].includes(mode))
    throw new Error(
      "Usage: build-guard.ts report | clean [--apply] [--compiled] | web | tauri <args>"
    )
  if (
    mode === "clean" &&
    args.some((arg) => !["--apply", "--compiled"].includes(arg))
  )
    throw new Error("Unknown cleanup option")
  if (mode === "clean" && !args.includes("--apply")) {
    console.log("Dry run; no files will be removed:")
    console.log(
      (await cacheCandidates(root, args.includes("--compiled"))).join("\n")
    )
    await report()
    return 0
  }
  const target = resolve(root, "src-tauri/target")
  if (
    (process.env.CARGO_TARGET_DIR &&
      resolve(root, process.env.CARGO_TARGET_DIR) !== target) ||
    process.env.CARGO_BUILD_BUILD_DIR ||
    args.some(
      (arg) => arg === "--target-dir" || arg.startsWith("--target-dir=")
    )
  )
    throw new Error(
      "Use the shared src-tauri/target cache; separate target/build directories are not supported by the build guard."
    )
  // Tauri's beforeBuildCommand calls build:web inside this same guarded build.
  if (mode === "web" && process.env.REVIEWBOX_BUILD_GUARD) {
    const owner = JSON.parse(
      await readFile(resolve(lock, "owner.json"), "utf8")
    )
    if (owner.token !== process.env.REVIEWBOX_BUILD_GUARD)
      throw new Error("Build guard ownership mismatch")
    process.kill(owner.pid, 0)
    return build(process.env)
  }
  try {
    await mkdir(lock)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        "Another guarded build/cleanup owns .reviewbox-build-lock. If it was interrupted, verify its owner.json PID has exited before removing that lock directory."
      )
    throw error
  }
  try {
    const token = crypto.randomUUID()
    await writeFile(
      resolve(lock, "owner.json"),
      JSON.stringify({ pid: process.pid, token })
    )
    if (mode === "clean") {
      await prune(args.includes("--compiled"))
      await report()
      return 0
    }
    await idle()
    await enforce()
    const result = await build({
      ...process.env,
      CARGO_TARGET_DIR: target,
      CARGO_INCREMENTAL: "0",
      REVIEWBOX_BUILD_GUARD: token,
    })
    // Also runs after an ordinary failed build; never removes the produced app.
    await prune()
    if (overBudget(await report()))
      throw new Error(
        "Build artifacts exceeded the storage budget. Outputs are kept; use build:clean --apply --compiled after verification before another build."
      )
    return result
  } finally {
    await rm(lock, { recursive: true, force: true })
  }
}

try {
  process.exitCode = await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
