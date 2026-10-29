import { afterEach, expect, test } from "bun:test"
import bundled from "../../../../resources/languages/languages.json"
import { configureCodeLanguages } from "@/lib/code/languages"
import { detectProjectLanguage } from "./projectLanguage"

const file = (path: string, ignored = false) => ({
  path,
  directory: false,
  ignored,
})
afterEach(() => configureCodeLanguages(bundled))

test("ambiguous headers use nearby unambiguous C or C++ sources", () => {
  expect(
    detectProjectLanguage("include/api.h", "", [file("src/main.c")])
  ).toMatchObject({ source: "project", language: { id: "c" } })
  expect(
    detectProjectLanguage("include/api.h", "", [file("src/main.cpp")])
  ).toMatchObject({ source: "project", language: { id: "cpp" } })
})

test("mixed sources and ambiguous headers leave the decision to content", () => {
  const decision = detectProjectLanguage("include/api.h", "", [
    file("src/main.c"),
    file("src/widget.cpp"),
    file("include/other.h"),
  ])
  expect(decision.source).toBe("plaintext")
  expect(decision.candidates.map((language) => language.id)).toEqual([
    "c",
    "cpp",
  ])
  expect(
    detectProjectLanguage("include/api.h", "", [file("include/other.h")]).source
  ).toBe("plaintext")
})

test("the nearest nested project wins without mixing sibling projects", () => {
  const entries = [
    file("packages/library/src/main.c"),
    file("packages/app/src/main.cpp"),
    file("outer.cpp"),
  ]
  expect(
    detectProjectLanguage("packages/library/include/api.h", "", entries)
  ).toMatchObject({ source: "project", language: { id: "c" } })
  expect(
    detectProjectLanguage("packages/app/include/api.h", "", entries)
  ).toMatchObject({ source: "project", language: { id: "cpp" } })
  expect(detectProjectLanguage("include/api.h", "", entries).source).toBe(
    "plaintext"
  )
})

test("ignored sources and directory names do not influence the decision", () => {
  expect(
    detectProjectLanguage("include/api.h", "", [
      file("src/main.c"),
      file("build/generated.cpp", true),
      { path: "a-folder.cpp", directory: true },
    ])
  ).toMatchObject({ source: "project", language: { id: "c" } })
  expect(
    detectProjectLanguage("include/api.h", "", [
      file("build/generated.cpp", true),
    ]).source
  ).toBe("plaintext")
})

test("project hints preserve filename, unique extension and shebang priority", () => {
  const entries = [file("src/main.c")]
  expect(detectProjectLanguage("tsconfig.app.json", "", entries)).toMatchObject(
    {
      source: "filename",
      language: { id: "jsonc" },
    }
  )
  expect(detectProjectLanguage("source.cpp", "", entries)).toMatchObject({
    source: "extension",
    language: { id: "cpp" },
  })
  expect(
    detectProjectLanguage("script.h", "#!/usr/bin/env python3", entries)
  ).toMatchObject({ source: "firstLine", language: { id: "python" } })
  expect(detectProjectLanguage("script", "", entries)).toMatchObject({
    source: "plaintext",
    candidates: [],
  })
})

test("the inventory cache follows registry and snapshot changes", () => {
  const entries = [file("source.custom")]
  expect(detectProjectLanguage("api.h", "", entries).source).toBe("plaintext")
  configureCodeLanguages(
    bundled.map((language) =>
      language.id === "c"
        ? { ...language, extensions: [...language.extensions, "custom"] }
        : language
    )
  )
  expect(detectProjectLanguage("api.h", "", entries)).toMatchObject({
    source: "project",
    language: { id: "c" },
  })
  expect(
    detectProjectLanguage("api.h", "", [...entries, file("other.cpp")]).source
  ).toBe("plaintext")
})
