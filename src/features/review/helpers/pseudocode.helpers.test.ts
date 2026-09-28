import { expect, test } from "bun:test"
import type {
  Change,
  ReviewFileContent,
} from "@/lib/desktop/contracts.generated"
import { pseudoDiff, pseudoPassage } from "./pseudocode.helpers"

const blob = { hash: "hash", size: 20, mode: "100644" }
const change: Change = {
  id: "change",
  path: "a.ts",
  previousPath: null,
  layer: "staged",
  before: blob,
  after: blob,
  binary: false,
  untracked: false,
  passages: [],
}
const content: ReviewFileContent = {
  pseudocodeSkipReason: null,
  fileId: "file",
  documents: null,
  translations: [
    {
      sourceId: "change:change:before",
      sourceHash: "hash",
      unavailableReason: null,
      blocks: [
        { startLine: 1, endLine: 4, text: "READ old value" },
        { startLine: 5, endLine: 8, text: "RETURN old value\nEND" },
      ],
    },
    {
      sourceId: "change:change:after",
      sourceHash: "hash",
      unavailableReason: null,
      blocks: [
        {
          startLine: 1,
          endLine: 4,
          text: "READ new value\nIF present\nTHEN continue",
        },
        { startLine: 5, endLine: 8, text: "RETURN new value" },
      ],
    },
  ],
}
test("a model omission is explicit and never replaced by source or cached pseudo-code", () => {
  expect(
    pseudoDiff(change, {
      ...content,
      pseudocodeSkipReason: "Only type declarations.",
    })
  ).toEqual({
    before: null,
    after: null,
    unavailableReason: null,
    skipReason: "Pseudo-code is not available for this file.",
  })
})
test("pseudo diff renders complete before and after text, never the raw source", () => {
  expect(pseudoDiff(change, content)).toEqual({
    before: "READ old value\nRETURN old value\nEND",
    after: "READ new value\nIF present\nTHEN continue\nRETURN new value",
    unavailableReason: null,
  })
})
test("source anchors are mapped to translated coordinates independently on each side", () => {
  const mapped = pseudoPassage(
    change,
    {
      id: "passage",
      oldStart: 6,
      oldLines: 1,
      newStart: 6,
      newLines: 2,
      fingerprint: "fp",
    },
    content
  )
  expect(mapped).toEqual({
    id: "passage",
    oldStart: 2,
    oldLines: 2,
    newStart: 4,
    newLines: 1,
    fingerprint: "fp",
  })
})
test("absent sides are empty; missing required translations remain explicit", () => {
  const added = { ...change, before: null }
  const onlyAfter = { ...content, translations: content.translations.slice(1) }
  expect(pseudoDiff(added, onlyAfter).unavailableReason).toBeNull()
  expect(pseudoDiff(added, onlyAfter).before).toBe("")
  expect(pseudoDiff(change, onlyAfter).unavailableReason).toContain(
    "unavailable"
  )
  expect(pseudoDiff(change, null).unavailableReason).toBe("Loading pseudocode…")
})
test("unavailable translations never show their partial text", () => {
  const missing = {
    ...content,
    translations: content.translations.map((item) => ({
      ...item,
      unavailableReason: "Source could not be translated.",
    })),
  }
  expect(pseudoDiff(change, missing)).toEqual({
    before: "",
    after: "",
    unavailableReason: "Source could not be translated.",
  })
})
