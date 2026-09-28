import { describe, expect, test } from "bun:test"
import { highlightCode } from "./highlighter"
import { resolveCodeLanguage, resolveLanguageId } from "./languages"
import { tokenizePseudocode } from "./pseudocode"
import { codeThemes } from "./themes"

describe("code languages", () => {
  test("resolves real embedded grammars, special filenames and shebangs", () => {
    expect(resolveCodeLanguage("components/Result.tsx")).toMatchObject({
      id: "tsx",
      lspId: "typescriptreact",
    })
    expect(resolveCodeLanguage("Cargo.toml").id).toBe("toml")
    expect(resolveCodeLanguage("Dockerfile.prod").id).toBe("dockerfile")
    expect(resolveCodeLanguage("tsconfig.app.json").id).toBe("jsonc")
    expect(resolveCodeLanguage(".env.production").id).toBe("dotenv")
    expect(
      resolveCodeLanguage("scripts/run", "#!/usr/bin/env python3").id
    ).toBe("python")
    expect(resolveLanguageId("typescriptreact").id).toBe("tsx")
    expect(resolveCodeLanguage("file.unknown").id).toBe("plaintext")
  })
})

describe("source coloring", () => {
  test("Tokyo Night distinguishes JSX tags, attributes, functions, parameters and types", async () => {
    const source =
      "const Label = ({ value }: { value: string }) => <button aria-label={value}>{value}</button>"
    const tokens = (await highlightCode(source, "tsx", "tokyo-night-dark"))[0]
    expect(tokens.map((token) => token.content).join("")).toBe(source)
    const color = (value: string) =>
      tokens.find((token) => token.content === value)?.color
    expect(
      new Set([
        color("Label"),
        color("button"),
        color("aria-label"),
        color("string"),
        color("value"),
      ]).size
    ).toBe(5)
    expect(color("button")).toBe("#F7768E")
  })
  test("theme and source metadata cannot execute HTML and ReviewBox surfaces remain unchanged", async () => {
    for (const theme of codeThemes) {
      expect(theme.colors?.["editor.background"]).toBe(
        theme.type === "dark" ? "#222222" : "#ffffff"
      )
    }
    const text = '{ "url": "<script>alert(1)</script>", "enabled": true }'
    const tokens = (await highlightCode(text, "json", "tokyo-night-light"))[0]
    expect(tokens.map((token) => token.content).join("")).toBe(text)
    expect(new Set(tokens.map((token) => token.color)).size).toBeGreaterThan(2)
  })
  test("unknown languages remain readable and exact", async () => {
    const text = "an unknown syntax <safe>\n  exactly preserved"
    const lines = await highlightCode(text, "missing", "reviewbox-light")
    expect(
      lines
        .map((line) => line.map((token) => token.content).join(""))
        .join("\n")
    ).toBe(text)
  })
})

describe("shared pseudo-code lexer", () => {
  test("capitalized narrative stays neutral and reserved names remain properties", () => {
    for (const narrative of [
      "The cache will return a saved value",
      "An API call awaits IO and returns a message.",
      "Some fields are empty or missing",
    ]) {
      expect(
        tokenizePseudocode(narrative)[0].every(
          (token) => token.kind === "plain"
        )
      ).toBe(true)
    }
    const tokens = tokenizePseudocode(
      "RETURN payload.return + payload.type + payload.true"
    )[0]
    expect(
      tokens
        .filter((token) => ["return", "type", "true"].includes(token.text))
        .map((token) => token.kind)
    ).toEqual(["property", "property", "property"])
    expect(tokenizePseudocode("fetchUser(userId)")[0][0].kind).toBe("function")
  })
  test("classifies structure and identifiers without coloring prose as declarations", () => {
    const lines = tokenizePseudocode(
      'FUNCTION loadUser(userId, options)\n  IF userId IS NOT NULL THEN\n    RETURN fetchUser(userId).displayName\n  ELSE IF isLoading\n    SHOW "IF loading"\n  # RETURN 42 is a comment\n  SET retryCount = -2.5'
    )
    const token = (line: number, word: string) =>
      lines[line].find((part) => part.text === word)?.kind
    expect(token(0, "loadUser")).toBe("function")
    expect(token(0, "userId")).toBe("parameter")
    expect(token(1, "IS NOT")).toBe("keyword.control")
    expect(token(2, "fetchUser")).toBe("function")
    expect(token(2, "displayName")).toBe("property")
    expect(token(3, "ELSE IF")).toBe("keyword.control")
    expect(token(4, '"IF loading"')).toBe("string")
    expect(lines[5].at(-1)?.kind).toBe("comment")
    expect(token(6, "-2.5")).toBe("number")
    expect(
      tokenizePseudocode("the supplied value remains unchanged")[0].every(
        (part) => part.kind === "plain"
      )
    ).toBe(true)
  })
  test("keeps indentation, escapes, multilingual existing text and multiline comments intact", () => {
    const text =
      '  SI present\n    READ "a \\\"quoted\\\" value"\n/* IF 123\n   still a comment */ RETURN value\n'
    const lines = tokenizePseudocode(text)
    expect(
      lines.map((line) => line.map((part) => part.text).join("")).join("\n")
    ).toBe(text)
    expect(lines[2][0].kind).toBe("comment")
    expect(lines[3][0].kind).toBe("comment")
    expect(lines[3].some((part) => part.kind === "keyword.control")).toBe(true)
  })
})
