import { afterEach, expect, test } from "bun:test"
import bundled from "../../../resources/languages/languages.json"
import {
  configureCodeLanguages,
  detectCodeLanguage,
  resolveCodeLanguage,
  resolveLanguageId,
} from "./languages"

afterEach(() => configureCodeLanguages(bundled))

test("explicit language identities win over extension aliases", () => {
  configureCodeLanguages([
    {
      id: "first",
      name: "First",
      lspId: "server-first",
      extensions: ["second"],
    },
    { id: "second", name: "Second", lspId: "server-second", extensions: [] },
  ])
  expect(resolveLanguageId("second").id).toBe("second")
  expect(resolveLanguageId("server-second").id).toBe("second")
})

test("ambiguous extensions do not depend on pack registration order", () => {
  const languages = [
    { id: "c", name: "C", lspId: "c", extensions: ["h"] },
    { id: "cpp", name: "C++", lspId: "cpp", extensions: ["h"] },
  ]
  configureCodeLanguages(languages)
  expect(detectCodeLanguage("include/api.h")).toMatchObject({
    source: "plaintext",
    language: { id: "plaintext" },
  })
  expect(
    detectCodeLanguage("include/api.h").candidates.map((c) => c.id)
  ).toEqual(["c", "cpp"])
  configureCodeLanguages([...languages].reverse())
  expect(detectCodeLanguage("include/api.h").language.id).toBe("plaintext")
})

test("specific names and unambiguous extensions precede first-line detection", () => {
  expect(detectCodeLanguage("tsconfig.app.json").source).toBe("filename")
  expect(detectCodeLanguage("file.js", "#!/usr/bin/python3")).toMatchObject({
    source: "extension",
    language: { id: "javascript" },
  })
  expect(
    detectCodeLanguage("scripts/run", "#!/usr/bin/env -S python3 -u")
  ).toMatchObject({ source: "firstLine", language: { id: "python" } })
})

test("captured readers preserve header coloring while live editors resolve ambiguity", () => {
  expect(resolveCodeLanguage("include/types.h").id).toBe("cpp")
  expect(detectCodeLanguage("include/types.h").language.id).toBe("plaintext")
})

test("custom packs resolve without needing a statistical model entry", () => {
  configureCodeLanguages([
    ...bundled,
    {
      id: "custom-lang",
      name: "Custom",
      lspId: "custom-server",
      extensions: ["custom"],
      filenames: ["Customfile"],
    },
  ])
  expect(detectCodeLanguage("file.custom").language.id).toBe("custom-lang")
  expect(detectCodeLanguage("Customfile").source).toBe("filename")
})
