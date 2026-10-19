import { expect, test } from "bun:test"
import type { Change } from "@/lib/desktop/contracts.generated"
import { searchReviewContent } from "./reviewContentSearch"

const change = (id: string): Change => ({
  id,
  path: `src/${id}.ts`,
  before: { hash: "before", size: 30, mode: "100644" },
  after: { hash: "after", size: 30, mode: "100644" },
  binary: false,
  untracked: false,
  previousPath: null,
  layer: "unstaged",
  passages: [],
})
test("captured search includes deleted and added sources with literal UTF-16 ranges and progressive batches", async () => {
  const batches: number[] = []
  const result = await searchReviewContent(
    [change("first"), change("second")],
    "[needle]",
    "q",
    new AbortController().signal,
    async (id) => ({
      before: id === "first" ? "😀 [needle]\r\n" : null,
      after: id === "second" ? "prefix\r\n[NEEDLE]" : "replaced",
      unavailableReason: null,
    }),
    (value) => batches.push(value.scannedFiles)
  )
  expect(batches).toEqual([1, 2])
  expect(
    result.matches.map((m) => [m.changeId, m.side, m.line, m.column, m.length])
  ).toEqual([
    ["first", "before", 1, 4, 8],
    ["second", "after", 2, 1, 8],
  ])
})
test("cancelled captured reads publish no stale batch or follow-up read", async () => {
  const controller = new AbortController()
  let reads = 0,
    batches = 0
  const result = await searchReviewContent(
    [change("one"), change("two")],
    "needle",
    "q",
    controller.signal,
    async () => {
      reads++
      controller.abort()
      return { before: null, after: "needle", unavailableReason: null }
    },
    () => {
      batches++
    }
  )
  expect(result.cancelled).toBe(true)
  expect(reads).toBe(1)
  expect(batches).toBe(0)
})
test("result ceilings are explicit and binaries are skipped before reading", async () => {
  const binary = { ...change("binary"), binary: true }
  const result = await searchReviewContent(
    [binary, change("large")],
    "x",
    "q",
    new AbortController().signal,
    async (id) => {
      expect(id).toBe("large")
      return {
        before: null,
        after: "x\n".repeat(1100),
        unavailableReason: null,
      }
    },
    () => {}
  )
  expect(result.skippedFiles).toBe(1)
  expect(result.truncated).toBe(true)
  expect(result.matches).toHaveLength(1000)
})
