import { lstat, readdir, rm, statfs } from "node:fs/promises"
import { join } from "node:path"

export const GiB = 1024 ** 3
export const budget = 20 * GiB
export const reserve = 10 * GiB
const roots = ["src-tauri/target", "target", ".next", "out", "artifacts"]

async function info(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

/** Never traverse symlinks, including intermediate path components. */
async function owned(root: string, relative: string) {
  let path = root
  for (const part of relative.split("/")) {
    if (!part || part === "." || part === "..")
      throw new Error("Invalid artifact path")
    path = join(path, part)
    const stat = await info(path)
    if (stat?.isSymbolicLink())
      throw new Error(`Refusing linked artifact path: ${relative}`)
  }
  return path
}

async function size(path: string): Promise<number> {
  const stat = await info(path)
  if (!stat || stat.isSymbolicLink()) return 0
  if (!stat.isDirectory()) return stat.size
  let bytes = 0
  for (const item of await readdir(path)) bytes += await size(join(path, item))
  return bytes
}

export async function storageReport(root: string) {
  const directories = []
  for (const relative of roots) {
    directories.push({
      path: relative,
      bytes: await size(await owned(root, relative)),
    })
  }
  const disk = await statfs(root)
  return {
    directories,
    total: directories.reduce((sum, item) => sum + item.bytes, 0),
    free: disk.bavail * disk.bsize,
  }
}

export function overBudget(report: { total: number; free: number }) {
  return report.total > budget || report.free < reserve
}

export const gib = (bytes: number) => `${(bytes / GiB).toFixed(2)} GiB`

export async function cacheCandidates(root: string, compiled: boolean) {
  const candidates: string[] = []
  for (const target of ["src-tauri/target", "target"]) {
    const path = await owned(root, target)
    if (!(await info(path))) continue
    const triples = (await readdir(path, { withFileTypes: true }))
      .filter(
        (entry) =>
          (entry.isDirectory() || entry.isSymbolicLink()) &&
          /^[\w.]+(?:-[\w.]+){2,}$/.test(entry.name)
      )
      .map((entry) => entry.name)
    for (const prefix of [
      target,
      ...triples.map((triple) => `${target}/${triple}`),
    ]) {
      for (const profile of ["debug", "release"]) {
        for (const cache of compiled
          ? ["incremental", "deps", "build", ".fingerprint", "examples"]
          : ["incremental"]) {
          const relative = `${prefix}/${profile}/${cache}`
          await owned(root, relative)
          candidates.push(relative)
        }
      }
    }
  }
  return candidates
}

/** Call only while holding the build guard lock and with Cargo/rustc idle. */
export async function pruneCaches(root: string, compiled = false) {
  const candidates = await cacheCandidates(root, compiled)
  let removed = 0
  for (const relative of candidates) {
    const path = await owned(root, relative)
    removed += await size(path)
    await rm(path, { recursive: true, force: true })
  }
  return removed
}
