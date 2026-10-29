import { describe, expect, test } from "bun:test"
import {
  availableLayer,
  nextLocalFile,
  nextLocalFileInLayer,
  fullyStagedPaths,
  localFileStatuses,
  localFileGroups,
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

test("a partially staged file appears in both groups with each layer's status", () => {
  const partial = file("src/partial.ts", "A", "D")
  const conflict = file("conflict.ts", "U", "U", true)
  const groups = localFileGroups([
    partial,
    file("new.ts", null, "U"),
    file("ready.ts", "M", null),
    conflict,
  ])
  expect(groups.unstaged.map((file) => file.path)).toEqual([
    "src/partial.ts",
    "new.ts",
    "conflict.ts",
  ])
  expect(groups.staged.map((file) => file.path)).toEqual([
    "src/partial.ts",
    "ready.ts",
  ])
  expect(localFileStatuses(groups.unstaged, "unstaged")[partial.path]).toBe("D")
  expect(localFileStatuses(groups.staged, "staged")[partial.path]).toBe("A")
})

test("staging advances in displayed order, skipping the batch and opposite layer", () => {
  expect(nextLocalFile(["c", "a", "b", "d"], new Set(["c", "d"]), "a")).toBe(
    "d"
  )
  expect(nextLocalFile(["c", "a", "b", "d"], new Set(["c"]), "d")).toBe("c")
  expect(nextLocalFile(["only"], new Set(), "only")).toBeUndefined()
})

test("after staging, skip already staged files using the returned Git state", () => {
  const files = [
    file("a", "M", null),
    file("b", "M", null),
    file("c", null, "M"),
  ]
  expect(
    nextLocalFileInLayer(
      ["a", "b", "c"],
      files,
      "a",
      "unstaged",
      new Set(["a"])
    )
  ).toBe("c")
  expect(
    nextLocalFileInLayer(
      ["c", "a", "b"],
      files,
      "a",
      "unstaged",
      new Set(["a"])
    )
  ).toBe("c")
  expect(
    nextLocalFileInLayer(
      ["a", "b"],
      files.slice(0, 2),
      "a",
      "unstaged",
      new Set(["a"])
    )
  ).toBeUndefined()
})

test("remaining unstaged work includes partial files but excludes conflicts and the batch", () => {
  const files = [
    file("a", "M", null),
    file("b", "M", "M"),
    file("c", "U", "U", true),
    file("d", null, "M"),
  ]
  expect(
    nextLocalFileInLayer(
      ["a", "b", "c", "d"],
      files,
      "a",
      "unstaged",
      new Set(["a"])
    )
  ).toBe("b")
  expect(
    nextLocalFileInLayer(
      ["a", "b", "c", "d"],
      files,
      "a",
      "unstaged",
      new Set(["a", "b"])
    )
  ).toBe("d")
})
