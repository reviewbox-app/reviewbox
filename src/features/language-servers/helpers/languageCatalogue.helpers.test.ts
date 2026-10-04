import { describe, expect, test } from "bun:test"
import type { LanguageServerCatalogueEntry } from "@/lib/desktop/contracts.generated"
import {
  activeInstallation,
  capabilityLabels,
  recommendedServers,
} from "./languageCatalogue.helpers"

const entry = (id: string, languages: string[]) =>
  ({ id, languages }) as LanguageServerCatalogueEntry

describe("language catalogue", () => {
  test("recommendations cover exact filenames, compound extensions and mixed case", () => {
    const entries = [
      entry("typescript", ["typescript", "typescriptreact"]),
      entry("docker", ["dockerfile"]),
      entry("ruby", ["ruby"]),
      entry("rust", ["rust"]),
    ]
    expect([
      ...recommendedServers(entries, [
        "src/App.TSX",
        "src/env.d.ts",
        "ops/Dockerfile.dev",
        "Gemfile",
        "README.md",
      ]),
    ]).toEqual(["typescript", "docker", "ruby"])
    expect([...recommendedServers(entries, [])]).toEqual([])
  })
  test("only active operations are cancellable and capabilities come from observed servers", () => {
    expect(activeInstallation("queued")).toBe(true)
    expect(activeInstallation("installing")).toBe(true)
    for (const status of ["failed", "cancelled", "ready", undefined])
      expect(activeInstallation(status)).toBe(false)
    expect(capabilityLabels(entry("typescript", []))).toEqual([])
    expect(
      capabilityLabels({
        ...entry("typescript", []),
        liveCapabilities: {
          completionProvider: {},
          renameProvider: true,
          hoverProvider: false,
        },
      })
    ).toEqual(["Completion", "Rename"])
    expect(
      capabilityLabels({
        ...entry("typescript", []),
        capabilities: {
          semanticTokens: true,
          hover: true,
          definitions: false,
          references: false,
          symbols: true,
        },
      })
    ).toEqual(["Semantic colors", "Hover", "Symbols"])
  })
})
