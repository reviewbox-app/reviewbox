import { describe, expect, test } from "bun:test"
import {
  availableLayer,
  fullyStagedPaths,
  localFileStatuses,
} from "./local-files"
import type { LocalFile } from "@/lib/desktop/contracts.generated"
const file = (
  path: string,
  stagedStatus: string | null,
  unstagedStatus: string | null,
  conflicted = false
): LocalFile => ({
  path,
  previousPath: null,
  stagedStatus,
  unstagedStatus,
  conflicted,
  version: path,
})
describe("live Git file presentation", () => {
  test("dims only wholly staged files, never a partial file or a conflict", () => {
    const files = [
      file("a.ts", "M", null),
      file("b.ts", "M", "M"),
      file("c.ts", null, "U"),
      file("d.ts", "U", null, true),
    ]
    expect([...fullyStagedPaths(files)]).toEqual(["a.ts"])
  })
  test("preserves a chosen staged layer and falls back only when it disappears", () => {
    expect(availableLayer(file("a", "M", "M"), "staged")).toBe("staged")
    expect(availableLayer(file("a", null, "M"), "staged")).toBe("unstaged")
    expect(availableLayer(file("a", "M", null), "unstaged")).toBe("staged")
  })
  test("dims folders only when every modified descendant is wholly staged", () => {
    const files = [
      file("src/ready/a.ts", "A", null),
      file("src/ready/b.ts", "M", null),
      file("src/partial/c.ts", "M", "M"),
    ]
    const paths = fullyStagedPaths(files)
    expect(paths.has("src/ready")).toBe(true)
    expect(paths.has("src/partial")).toBe(false)
    expect(paths.has("src")).toBe(false)
    expect(fullyStagedPaths(files.slice(0, 2)).has("src")).toBe(true)
  })
  test("retains addition/rename status across partially staged layers", () => {
    expect(
      localFileStatuses([
        file("a", "A", "M"),
        file("b", "R", "M"),
        file("c", null, "U"),
      ])
    ).toEqual({ a: "A", b: "R", c: "U" })
  })
})
