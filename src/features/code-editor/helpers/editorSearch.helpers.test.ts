import { expect, test } from "bun:test"
import { findEditorFiles, indexEditorFiles } from "./editorSearch.helpers"

test("filename search excludes ignored files and directory-only matches", () => {
  const index = indexEditorFiles(
    [
      { path: "ignored/cache.ts", directory: false, revision: "" },
      { path: "src/Main.ts", directory: false, revision: "" },
      { path: "src/empty", directory: true, revision: "" },
    ],
    new Set(["ignored/cache.ts"])
  )
  expect(findEditorFiles(index, "MAIN").paths).toEqual(["src/Main.ts"])
  expect(findEditorFiles(index, "ignored").paths).toEqual([])
  expect(findEditorFiles(index, "empty").paths).toEqual([])
})

test("filename results are bounded without losing paths from the index", () => {
  const index = indexEditorFiles(
    Array.from({ length: 1100 }, (_, i) => ({
      path: `src/${i}.ts`,
      directory: false,
      revision: "",
    })),
    new Set()
  )
  expect(findEditorFiles(index, ".ts").paths).toHaveLength(1000)
  expect(findEditorFiles(index, ".ts").truncated).toBe(true)
  expect(findEditorFiles(index, "1099.ts").paths).toEqual(["src/1099.ts"])
})
