import { expect, test } from "bun:test"
import { selectFiles } from "./file-selection"
const plain = { shiftKey: false, metaKey: false, ctrlKey: false }
test("range follows visible tree order and supports additive selection", () => {
  const paths = ["b", "a", "c"]
  expect([
    ...selectFiles(new Set(["z"]), "b", "c", paths, {
      ...plain,
      shiftKey: true,
    }),
  ]).toEqual(paths)
  expect([
    ...selectFiles(new Set(["z"]), "b", "a", paths, {
      ...plain,
      shiftKey: true,
      metaKey: true,
    }),
  ]).toEqual(["z", "b", "a"])
  expect([
    ...selectFiles(new Set(["a"]), "a", "a", paths, {
      ...plain,
      ctrlKey: true,
    }),
  ]).toEqual([])
  expect([
    ...selectFiles(new Set(["a"]), "hidden", "c", paths, {
      ...plain,
      shiftKey: true,
    }),
  ]).toEqual(["c"])
})
