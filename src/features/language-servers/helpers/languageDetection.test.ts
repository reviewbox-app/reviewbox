import { expect, test } from "bun:test"
import { languagePrediction } from "./languageDetection"

test("confident content predictions canonicalize model extension IDs", () => {
  expect(
    languagePrediction([
      { languageId: "py", confidence: 0.86 },
      { languageId: "ts", confidence: 0.1 },
    ])
  ).toEqual({
    languageId: "python",
    candidates: [
      { languageId: "python", confidence: 0.86 },
      { languageId: "typescript", confidence: 0.1 },
    ],
  })
})
test("uncertain, competing and unsupported predictions remain suggestions", () => {
  expect(
    languagePrediction([{ languageId: "ts", confidence: 0.4 }]).languageId
  ).toBeUndefined()
  expect(
    languagePrediction([
      { languageId: "ts", confidence: 0.65 },
      { languageId: "js", confidence: 0.6 },
    ]).languageId
  ).toBeUndefined()
  expect(
    languagePrediction([
      { languageId: "missing", confidence: 0.95 },
      { languageId: "py", confidence: 0.1 },
    ]).languageId
  ).toBeUndefined()
  expect(
    languagePrediction([{ languageId: "py", confidence: Number.NaN }])
      .candidates
  ).toEqual([])
  expect(
    languagePrediction([
      { languageId: "missing", confidence: 0.95 },
      { languageId: "py", confidence: 0.7 },
    ]).languageId
  ).toBeUndefined()
})
