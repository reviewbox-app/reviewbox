import { afterEach, expect, test } from "bun:test"
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  budget,
  overBudget,
  pruneCaches,
  reserve,
  storageReport,
} from "./build-storage"

const fixtures: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "reviewbox-storage-test-"))
  fixtures.push(root)
  return root
}
async function file(root: string, path: string) {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), "keep")
}
afterEach(async () => {
  for (const root of fixtures.splice(0))
    await rm(root, { recursive: true, force: true })
})

test("budget includes the exact boundary and enforces free space", () => {
  expect(overBudget({ total: budget, free: reserve })).toBe(false)
  expect(overBudget({ total: budget + 1, free: reserve })).toBe(true)
  expect(overBudget({ total: 0, free: reserve - 1 })).toBe(true)
})

test("incremental pruning preserves dependencies, packages and app data", async () => {
  const root = await fixture()
  const removed = [
    "src-tauri/target/debug/incremental/a",
    "src-tauri/target/aarch64-apple-darwin/release/incremental/b",
    "target/release/incremental/c",
  ]
  const kept = [
    "src-tauri/target/debug/deps/d",
    "src-tauri/target/release/bundle/app/a",
    "src-tauri/target/debug/reviewbox",
    ".reviewbox/data",
    "out/index.html",
  ]
  for (const path of [...removed, ...kept]) await file(root, path)
  expect((await storageReport(root)).total).toBe(28)
  expect(await pruneCaches(root)).toBe(12)
  for (const path of removed)
    expect(await Bun.file(join(root, path)).exists()).toBe(false)
  for (const path of kept)
    expect(await readFile(join(root, path), "utf8")).toBe("keep")
})

test("compiled cleanup removes only designated caches", async () => {
  const root = await fixture()
  for (const cache of [
    "deps",
    "build",
    ".fingerprint",
    "examples",
    "incremental",
  ])
    await file(root, `src-tauri/target/debug/${cache}/a`)
  await file(root, "src-tauri/target/debug/bundle/app/a")
  await file(root, "src-tauri/target/debug/reviewbox")
  expect(await pruneCaches(root, true)).toBe(20)
  expect((await storageReport(root)).total).toBe(8)
})

test("linked cache paths reject the whole cleanup before mutation", async () => {
  const root = await fixture()
  const external = await fixture()
  await file(root, "src-tauri/target/debug/incremental/a")
  await file(external, "sentinel")
  await mkdir(join(root, "src-tauri/target/release"), { recursive: true })
  await symlink(external, join(root, "src-tauri/target/release/incremental"))
  await expect(pruneCaches(root)).rejects.toThrow("linked artifact")
  expect(
    await Bun.file(join(root, "src-tauri/target/debug/incremental/a")).exists()
  ).toBe(true)
  expect(await readFile(join(external, "sentinel"), "utf8")).toBe("keep")
})

test("links inside a cache never traverse into external data", async () => {
  const root = await fixture()
  const external = await fixture()
  await file(root, "src-tauri/target/debug/incremental/a")
  await file(external, "sentinel")
  await symlink(external, join(root, "src-tauri/target/debug/incremental/link"))
  expect(await pruneCaches(root)).toBe(4)
  expect(await readFile(join(external, "sentinel"), "utf8")).toBe("keep")
})

test("guard preview preserves files and an existing lock blocks builds", async () => {
  const root = await fixture()
  await mkdir(join(root, "scripts"))
  for (const name of ["build-guard.ts", "build-storage.ts"])
    await cp(join(import.meta.dir, name), join(root, "scripts", name))
  await file(root, "src-tauri/target/debug/incremental/a")
  const execute = async (...args: string[]) => {
    const child = Bun.spawn(
      [process.execPath, "scripts/build-guard.ts", ...args],
      { cwd: root, stdout: "pipe", stderr: "pipe" }
    )
    return {
      code: await child.exited,
      error: await new Response(child.stderr).text(),
    }
  }
  expect((await execute("clean", "--compiled")).code).toBe(0)
  expect(
    await Bun.file(join(root, "src-tauri/target/debug/incremental/a")).exists()
  ).toBe(true)
  await mkdir(join(root, ".reviewbox-build-lock"))
  const result = await execute("tauri", "build")
  expect(result.code).toBe(1)
  expect(result.error).toContain("Another guarded build")
})

test("failed simulated build preserves output, prunes cache and releases lock", async () => {
  const root = await fixture()
  await mkdir(join(root, "scripts"))
  for (const name of ["build-guard.ts", "build-storage.ts"])
    await cp(join(import.meta.dir, name), join(root, "scripts", name))
  await mkdir(join(root, "node_modules/@tauri-apps/cli"), { recursive: true })
  await writeFile(
    join(root, "node_modules/@tauri-apps/cli/tauri.js"),
    `
    import { mkdir, writeFile } from "node:fs/promises";
    if (process.env.CARGO_INCREMENTAL !== "0") process.exit(9);
    for (const path of ["src-tauri/target/debug/incremental", "src-tauri/target/debug/bundle"]) {
      await mkdir(path, { recursive: true });
      await writeFile(path + "/result", "fixture");
    }
    process.exit(7);
  `
  )
  // Deterministic idle check; this fixture never starts a compiler.
  await mkdir(join(root, "bin"))
  await writeFile(join(root, "bin/ps"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  const child = Bun.spawn(
    [process.execPath, "scripts/build-guard.ts", "tauri", "build"],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        CARGO_TARGET_DIR: "",
        CARGO_BUILD_BUILD_DIR: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  )
  expect(await child.exited).toBe(7)
  expect(
    await Bun.file(
      join(root, "src-tauri/target/debug/incremental/result")
    ).exists()
  ).toBe(false)
  expect(
    await readFile(join(root, "src-tauri/target/debug/bundle/result"), "utf8")
  ).toBe("fixture")
  const { existsSync } = await import("node:fs")
  expect(existsSync(join(root, ".reviewbox-build-lock"))).toBe(false)
})
