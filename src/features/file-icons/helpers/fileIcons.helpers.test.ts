import { describe, expect, test } from "bun:test"
import { generateManifest } from "material-icon-theme"
import {
  defaultFileIconPreferences,
  type FileIconCatalog,
  type FileIconPreferences,
  type IconClone,
} from "../contracts/fileIcons.types"
import { resolveFileIcon, resolveFolderIcon } from "./fileIcons.helpers"
import { recolorIcon } from "./iconColors.helpers"

const catalog: FileIconCatalog = {
  version: "5.38.1",
  manifests: {
    default: generateManifest({ activeIconPack: "" }),
    nest: generateManifest({ activeIconPack: "nest" }),
  },
}
const clone = (overrides: Partial<IconClone>): IconClone => ({
  name: "custom",
  base: "settings",
  color: null,
  lightColor: null,
  fileNames: [],
  fileExtensions: [],
  folderNames: [],
  rootFolderNames: [],
  activeForPacks: [],
  ...overrides,
})
const prefs = (
  overrides: Partial<FileIconPreferences> = {}
): FileIconPreferences => ({ ...defaultFileIconPreferences, ...overrides })
const asset = (path: string, preferences = prefs()) =>
  resolveFileIcon(catalog, preferences, path, false)?.assetPath

describe("Material file icon resolution", () => {
  test("recognizes filenames, compound suffixes, extensionless files and Windows paths", () => {
    expect(asset("src/Widget.tsx")).toEndWith("react_ts.svg")
    expect(asset("src/types.d.ts")).toEndWith("typescript-def.svg")
    expect(asset("src/Widget.test.ts")).toEndWith("test-ts.svg")
    expect(asset("C:\\src\\package.json")).toEndWith("nodejs.svg")
    expect(asset("Dockerfile")).toEndWith("docker.svg")
    expect(asset("BUN.LOCK")).toEndWith("bun.svg")
    expect(asset("éxample.unknown")).toEndWith("file.svg")
  })
  test("uses the selected Nest pack", () => {
    expect(
      asset("user.controller.ts", prefs({ activeIconPack: "nest" }))
    ).toEndWith("nest-controller.clone.svg")
    expect(
      asset("user.controller.ts", prefs({ activeIconPack: "default" }))
    ).not.toEndWith("nest-controller.clone.svg")
  })
  test("custom file suffixes override matching built-in extensions without losing longer suffixes", () => {
    const preferences = prefs({
      fileClones: [
        clone({
          base: "prisma",
          color: "blue-300",
          fileExtensions: ["repository.ts"],
        }),
      ],
    })
    expect(
      resolveFileIcon(catalog, preferences, "order.repository.ts", false)
    ).toEqual({ assetPath: "./../icons/prisma.svg", color: "blue-300" })
    expect(asset("order.repository.test.ts", preferences)).toEndWith(
      "test-ts.svg"
    )
  })
  test("specific names take precedence unless an association explicitly overrides them", () => {
    expect(
      asset(
        "package.json",
        prefs({ fileAssociations: { "*.json": "settings" } })
      )
    ).toEndWith("nodejs.svg")
    expect(
      asset(
        "package.json",
        prefs({ fileAssociations: { "**.json": "settings" } })
      )
    ).toEndWith("settings.svg")
  })
  test("honors pack restrictions and lightColor", () => {
    const custom = clone({
      base: "nest",
      color: "blue-400",
      lightColor: "blue-700",
      fileExtensions: ["provider.ts"],
      activeForPacks: ["nest"],
    })
    expect(
      asset(
        "user.provider.ts",
        prefs({ activeIconPack: "default", fileClones: [custom] })
      )
    ).toEndWith("typescript.svg")
    expect(
      resolveFileIcon(
        catalog,
        prefs({ activeIconPack: "nest", fileClones: [custom] }),
        "user.provider.ts",
        true
      )?.color
    ).toBe("blue-700")
  })
  test("unresolved imported bases cannot produce paths or break generic fallback", () => {
    expect(
      asset(
        "user.ts",
        prefs({ fileAssociations: { "*.ts": "../../private.svg" } })
      )
    ).toEndWith("typescript.svg")
    expect(
      asset(
        "user.ts",
        prefs({
          fileClones: [clone({ base: "absent", fileExtensions: ["ts"] })],
        })
      )
    ).toEndWith("typescript.svg")
  })
})

describe("Material folder icon resolution", () => {
  test("resolves compacted folders by final basename and preserves open state", () => {
    expect(
      resolveFolderIcon(catalog, prefs(), "src/components", false)?.assetPath
    ).toEndWith("folder-components.svg")
    expect(
      resolveFolderIcon(catalog, prefs(), "src/components", false, true)
        ?.assetPath
    ).toEndWith("folder-components-open.svg")
  })
  test("applies imported clones in both states with a light palette", () => {
    const preferences = prefs({
      folderClones: [
        clone({
          name: "composites-folder",
          base: "folder-components",
          color: "teal-400",
          lightColor: "teal-700",
          folderNames: ["composites"],
        }),
      ],
    })
    expect(
      resolveFolderIcon(catalog, preferences, "src/composites", true, true)
    ).toEqual({
      assetPath: "./../icons/folder-components-open.svg",
      color: "teal-700",
    })
  })
  test("unsupported wildcard folder names and missing bases retain the generic icon", () => {
    const preferences = prefs({
      folderClones: [
        clone({ base: "folder-helpers", folderNames: ["*.helpers"] }),
      ],
    })
    expect(
      resolveFolderIcon(catalog, preferences, "order.helpers", false)?.assetPath
    ).toEndWith("folder.svg")
    expect(
      resolveFolderIcon(catalog, preferences, "unknown", false, true)?.assetPath
    ).toEndWith("folder-open.svg")
  })
})

describe("Material clone colors", () => {
  test("uses Material names and preserves different shades", () => {
    const svg = '<svg><path fill="#c0ca33"/><path fill="#f0f4c3"/></svg>'
    const colored = recolorIcon(svg, "teal-400")
    expect(colored).toContain('fill="#26a69a"')
    expect(colored).not.toContain("#c0ca33")
    const colors = [...colored.matchAll(/fill="(.*?)"/g)].map(
      (match) => match[1]
    )
    expect(colors[0]).not.toBe(colors[1])
  })
  test("preserves transparent fills, protected accents and geometry", () => {
    const svg =
      '<svg><path fill="none" d="M0 0"/><path fill="#ffffff"/><path data-mit-no-recolor="true" fill="#ff0000"/></svg>'
    expect(recolorIcon(svg, "#112233")).toBe(
      '<svg><path fill="none" d="M0 0"/><path fill="#112233"/><path data-mit-no-recolor="true" fill="#ff0000"/></svg>'
    )
  })
  test("invalid colors are rejected rather than interpolated into SVG", () => {
    expect(() =>
      recolorIcon('<svg fill="#ffffff"/>', "url(https://example.com)")
    ).toThrow("Unknown Material icon color")
  })
})

test("the shared icon preset includes Nest and the shipped variants for every installation", () => {
  expect(asset("user.controller.ts")).toEndWith("nest-controller.clone.svg")
  expect(
    resolveFileIcon(
      catalog,
      defaultFileIconPreferences,
      "order.repository.ts",
      false
    )
  ).toEqual({ assetPath: "./../icons/prisma.svg", color: "blue-300" })
  expect(
    resolveFolderIcon(
      catalog,
      defaultFileIconPreferences,
      "src/composites",
      false
    )?.color
  ).toBe("teal-400")
  expect(
    resolveFolderIcon(catalog, defaultFileIconPreferences, "src/menus", true)
      ?.color
  ).toBe("deep-purple-400")
  expect(
    defaultFileIconPreferences.folderClones.some(
      (c) => c.base === "folder-helpers"
    )
  ).toBe(false)
})
