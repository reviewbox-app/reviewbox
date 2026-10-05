/** Input is serialized and bounded even when a paste arrives faster than native IO. */
export function inputQueue(
  write: (bytes: number[]) => Promise<void>,
  fail: (error: unknown) => void
) {
  let tail = Promise.resolve()
  let queued = 0
  let stopped = false
  return {
    stop() {
      stopped = true
    },
    send(bytes: Uint8Array) {
      if (stopped) return
      if (queued + bytes.length > 1024 * 1024) {
        fail(
          new Error("Terminal input is full. Wait before pasting more text.")
        )
        return
      }
      queued += bytes.length
      for (let offset = 0; offset < bytes.length; offset += 16384) {
        const chunk = Array.from(bytes.subarray(offset, offset + 16384))
        tail = tail.then(async () => {
          try {
            if (!stopped) await write(chunk)
          } catch (error) {
            stopped = true
            fail(error)
          } finally {
            queued -= chunk.length
          }
        })
      }
    },
    flushed: () => tail,
  }
}
export function fileLinks(text: string) {
  const matches = text.matchAll(
    /(?:^|[\s("'])([^\s<>"'()]+\.[\w-]+)(?::(\d+)(?::(\d+))?)?/g
  )
  return [...matches]
    .filter((match) => !match[1].includes("://"))
    .map((match) => ({
      text: match[0].trimStart().replace(/^["'(]/, ""),
      path: match[1],
      line: Number(match[2] ?? 1),
      column: Number(match[3] ?? 1),
      start: match.index! + match[0].indexOf(match[1]) + 1,
      end: match.index! + match[0].length,
    }))
}
/** Terminal control chords must reach the shell, rather than app capture handlers. */
export function terminalOwnsKey(
  event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "key">
) {
  return (
    event.ctrlKey &&
    !event.metaKey &&
    !["`", "1", "2", "3", "4"].includes(event.key)
  )
}
