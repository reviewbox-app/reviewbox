import { expect, test } from "bun:test"
import { xmlLinkedRanges } from "./xmlLinkedEditing"
import { literalColors } from "./colors"
import { specifierContext, allowCompletion } from "./completions"
import { useExtensionsStore } from "./extensions.store"
import { highlightCode } from "@/lib/code/highlighter"

test("XML pairs belong to the same element and exclude attribute text, comments and CDATA", () => {
  const text =
    '<root title="node"><node><node/></node><!-- <node></node> --><![CDATA[<node></node>]]></root>'
  expect(
    xmlLinkedRanges(text, text.indexOf("<node>") + 2)?.map((r) =>
      text.slice(r.start, r.end)
    )
  ).toEqual(["node", "node"])
  const pairs = xmlLinkedRanges(text, text.indexOf("<node>") + 2)!
  expect(pairs[1].start).toBe(text.indexOf("</node>") + 2)
  expect(xmlLinkedRanges(text, text.indexOf("title=") + 8)).toBeUndefined()
  expect(xmlLinkedRanges(text, text.indexOf("<!--") + 7)).toBeUndefined()
  expect(xmlLinkedRanges(text, text.indexOf("CDATA") + 9)).toBeUndefined()
})
test("colors accept modern CSS including alpha and OKLCH and skip incomplete values", () => {
  const colors = literalColors(
    "#f08 #ff008080 rgb(30 20 0 / 50%) hsl(120 50% 50% / .3) oklch(70% .12 180) rgb("
  )
  expect(colors).toHaveLength(5)
  expect(colors[2].rgba).toEqual([30, 20, 0, 0.5])
  expect(colors[4].rgba).toEqual([36, 182, 161, 1])
})
test("module and resource contexts are classified without suppressing ordinary TypeScript members", () => {
  for (const source of [
    "import { x } from '@scope/u",
    "export * from 'rea",
    "require('rea",
    "import('rea",
  ])
    expect(specifierContext(source)?.packages).toBe(true)
  expect(specifierContext('src="images/')).toEqual({
    prefix: "images/",
    packages: false,
  })
  expect(specifierContext("import './com")).toEqual({
    prefix: "./com",
    packages: false,
  })
  expect(specifierContext('const text = "rea')).toBeUndefined()
  const before = useExtensionsStore.getState().preferences
  useExtensionsStore.setState({
    preferences: {
      ...before,
      enabled: {
        ...before.enabled,
        autoImport: false,
        npmIntellisense: false,
        pathIntellisense: false,
      },
    },
  })
  expect(allowCompletion({ label: "member" }, undefined)).toBe(true)
  expect(
    allowCompletion(
      { label: "member", labelDetails: { description: "Current namespace" } },
      undefined
    )
  ).toBe(true)
  expect(
    allowCompletion(
      {
        label: "Button",
        data: { entryNames: [{ name: "Button", source: "@ui" }] },
      },
      undefined
    )
  ).toBe(false)
  expect(
    allowCompletion({ label: "react" }, specifierContext("import 'rea"))
  ).toBe(false)
  useExtensionsStore.setState({ preferences: before })
})
test("ordinary and documentation comments share the half-opacity neutral code color", async () => {
  for (const theme of [
    "tokyo-night-dark",
    "reviewbox-dark",
    "tokyo-night-light",
    "reviewbox-light",
  ]) {
    const lines = await highlightCode(
      "// comment\n/** documentation */\nconst answer=42",
      "typescript",
      theme
    )
    const expected = theme.endsWith("dark") ? "#919191" : "#8C8C8C"
    for (const line of lines.slice(0, 2))
      for (const token of line.filter((t) => t.content.trim()))
        expect(token.color?.toUpperCase()).toBe(expected)
  }
})
