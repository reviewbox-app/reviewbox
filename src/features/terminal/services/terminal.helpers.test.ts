import { describe, expect, test } from "bun:test"
import { fileLinks, inputQueue, terminalOwnsKey } from "./terminal.helpers"

describe("terminal input", () => {
  test("serializes bounded chunks without losing Unicode bytes", async () => {
    const received: number[][] = []
    let running = 0
    const queue = inputQueue(
      async (bytes) => {
        expect(running++).toBe(0)
        await Promise.resolve()
        received.push(bytes)
        running--
      },
      () => {
        throw new Error("unexpected error")
      }
    )
    const bytes = new TextEncoder().encode("é👩‍💻".repeat(5000))
    queue.send(bytes)
    queue.send(new TextEncoder().encode("\u0003"))
    await queue.flushed()
    expect(received.every((chunk) => chunk.length <= 16384)).toBe(true)
    expect(new Uint8Array(received.flat())).toEqual(
      new Uint8Array([...bytes, 3])
    )
  })
  test("rejects overload and prevents writes after close or native failure", async () => {
    const errors: unknown[] = []
    let writes = 0
    const queue = inputQueue(
      async () => {
        writes++
        throw new Error("closed")
      },
      (error) => errors.push(error)
    )
    queue.send(new Uint8Array(1024 * 1024 + 1))
    queue.send(new Uint8Array(17000))
    await queue.flushed()
    queue.send(new Uint8Array(1))
    await queue.flushed()
    expect(writes).toBe(1)
    expect(errors).toHaveLength(2)
  })
  test("retains shell control chords, reserves navigation only", () => {
    for (const key of ["c", "d", "z", "k", "p", "n", "o", "f", "l"])
      expect(terminalOwnsKey({ key, ctrlKey: true, metaKey: false })).toBe(true)
    expect(terminalOwnsKey({ key: "`", ctrlKey: true, metaKey: false })).toBe(
      false
    )
    expect(terminalOwnsKey({ key: "k", ctrlKey: false, metaKey: true })).toBe(
      false
    )
  })
})
test("terminal links preserve columns and don't treat web URLs as files", () => {
  expect(fileLinks("  src/main.ts:12:4 and /tmp/a.rs:3")).toEqual([
    {
      text: "src/main.ts:12:4",
      path: "src/main.ts",
      line: 12,
      column: 4,
      start: 3,
      end: 18,
    },
    {
      text: "/tmp/a.rs:3",
      path: "/tmp/a.rs",
      line: 3,
      column: 1,
      start: 24,
      end: 34,
    },
  ])
  expect(fileLinks("https://example.com/a.ts:20")).toEqual([])
})
