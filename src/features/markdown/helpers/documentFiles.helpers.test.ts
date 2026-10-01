import { expect, test } from "bun:test"
import { isDocumentFile } from "./documentFiles.helpers"

test("document extensions and conventional names ignore case", () => {
  for (const path of [
    "docs/Guide.MD",
    "notes.markdown",
    "a.mdown",
    "a.mkd",
    "a.mkdn",
    "a.TXT",
    "a.text",
    "README",
    "license",
    "LICENCE",
    "COPYING.LESSER",
    "NOTICE.fr-FR",
    "CHANGELOG-2026",
    "AUTHORS",
    "CONTRIBUTORS",
    "TODO",
    "README.en.md",
    "LICENSE-MIT",
    "docs\\README.txt",
  ])
    expect(isDocumentFile(path)).toBe(true)
})

test("recognized code, excluded formats and unrelated files remain code", () => {
  for (const path of [
    "CMakeLists.txt",
    "CMAKELISTS.TXT",
    "README.ts",
    "LICENSE.json",
    "TODO.sh",
    "README.mdx",
    "README.adoc",
    "guide.asciidoc",
    "README.rst",
    "TODO.rest",
    "notes.csv",
    "source.ts",
    "readmeBackup",
    "something",
  ])
    expect(isDocumentFile(path)).toBe(false)
  expect(isDocumentFile("README", "#!/usr/bin/env bash")).toBe(false)
})

test("renames follow the captured destination instead of its previous extension", () => {
  const renamed = { previousPath: "guide.mdx", path: "guide.md" }
  expect(isDocumentFile(renamed.path)).toBe(true)
  expect(isDocumentFile(renamed.previousPath)).toBe(false)
  expect(isDocumentFile("readme.py")).toBe(false)
})
