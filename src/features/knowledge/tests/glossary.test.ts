import { describe, expect, test } from "bun:test"
import { matchGlossary } from "../helpers/glossary.helpers"
import type {
  GlossaryTerm,
  TermOccurrence,
} from "@/lib/desktop/contracts.generated"
const terms: GlossaryTerm[] = [
  {
    id: "t",
    term: "store",
    aliases: ["data store"],
    senses: [
      { id: "state", description: "Shared UI state" },
      { id: "db", description: "Persistent storage" },
    ],
    archived: false,
  },
]
describe("glossary occurrences", () => {
  test("chooses longest phrase without matching identifier substrings", () => {
    const matches = matchGlossary("restore and data store", terms)
    expect(matches).toHaveLength(1)
    expect(matches[0].text).toBe("data store")
    expect(matches[0].ambiguous).toBe(true)
  })
  test("one-off wins over an explicit global link and remains local", () => {
    const local: TermOccurrence = {
      id: "o",
      sectionId: "s",
      offset: 0,
      quote: "store",
      description: "Only this occurrence",
      termId: "t",
      senseId: "db",
    }
    const matches = matchGlossary("store then store", terms, [local], "s")
    expect(matches[0].descriptions).toEqual(["Only this occurrence"])
    expect(matches[1].ambiguous).toBe(true)
    expect(terms[0].senses).toHaveLength(2)
  })
  test("unicode offsets survive emoji and archived meanings are not auto-linked", () => {
    expect(matchGlossary("🔎 store", terms)[0].start).toBe(2)
    expect(matchGlossary("store", [{ ...terms[0], archived: true }])).toEqual(
      []
    )
  })
  test("an occurrence cannot move silently to another section", () => {
    const local: TermOccurrence = {
      id: "o",
      sectionId: "old",
      offset: 0,
      quote: "store",
      description: "Local",
      termId: null,
      senseId: null,
    }
    expect(matchGlossary("store", terms, [local], "new")[0].ambiguous).toBe(
      true
    )
  })
})
