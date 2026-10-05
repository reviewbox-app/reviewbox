export interface SaveSnapshot {
  text: string
  version: number
}

/** A bounded transaction; never apply an edit against a buffer that moved on. */
export async function runSaveActions(options: {
  read: () => SaveSnapshot | undefined
  apply: (before: SaveSnapshot, text: string) => SaveSnapshot | undefined
  actions: ((before: SaveSnapshot, signal: AbortSignal) => Promise<string>)[]
  warn: (error: unknown) => void
  timeoutMs?: number
}) {
  const original = options.read()
  if (!original) return
  let latest = original
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(
        new Error(
          "Save actions timed out. Saving without pending transformations."
        )
      )
    }, options.timeoutMs ?? 3000)
  })
  try {
    await Promise.race([
      timeout,
      (async () => {
        for (const action of options.actions) {
          const before = options.read()
          if (
            !before ||
            before.version !== latest.version ||
            controller.signal.aborted
          )
            return
          const text = await action(before, controller.signal)
          if (controller.signal.aborted) return
          const current = options.read()
          if (
            !current ||
            current.version !== before.version ||
            current.text !== before.text
          ) {
            controller.abort()
            options.warn(
              new Error(
                "Typing resumed. Pending save transformations were discarded."
              )
            )
            return
          }
          if (text !== before.text) {
            const applied = options.apply(before, text)
            if (!applied) return
            latest = applied
          }
        }
      })(),
    ])
  } catch (error) {
    controller.abort()
    // Roll back our own transformations only while no user input has intervened.
    const current = options.read()
    if (
      current?.version === latest.version &&
      current.text === latest.text &&
      latest !== original
    )
      options.apply(current, original.text)
    options.warn(error)
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}
