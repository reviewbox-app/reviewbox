import {
  LANGUAGE_DETECTION_LIMIT,
  type LanguageCandidate,
} from "../helpers/languageDetection"

interface Pending {
  resolve: (candidates: LanguageCandidate[]) => void
  reject: (error: Error) => void
  cleanup: () => void
}

/** One lazy worker is shared; terminating it bounds the model's retained tensors. */
export class LanguageDetectionClient {
  private worker?: Worker
  private pending = new Map<string, Pending>()
  private idle?: ReturnType<typeof setTimeout>
  private completed = 0

  constructor(
    private readonly createWorker = () =>
      new Worker("/monaco/language-detection.worker.js")
  ) {}

  detect(content: string, signal: AbortSignal): Promise<LanguageCandidate[]> {
    if (signal.aborted) return Promise.reject(new Error("Detection cancelled"))
    const sample = content.slice(0, LANGUAGE_DETECTION_LIMIT)
    if (sample.trim().length < 20) return Promise.resolve([])
    clearTimeout(this.idle)
    if (!this.worker) {
      try {
        const worker = this.createWorker()
        this.worker = worker
        worker.onmessage = (
          event: MessageEvent<{
            id: string
            candidates?: LanguageCandidate[]
            error?: string
          }>
        ) => {
          if (this.worker !== worker) return
          const request = this.pending.get(event.data.id)
          if (request) {
            this.pending.delete(event.data.id)
            request.cleanup()
            if (event.data.error) request.reject(new Error(event.data.error))
            else request.resolve(event.data.candidates ?? [])
          }
          this.completed++
          this.releaseWhenIdle()
        }
        worker.onerror = () => {
          if (this.worker === worker)
            this.dispose(new Error("Language detection unavailable"))
        }
        worker.onmessageerror = () => {
          if (this.worker === worker)
            this.dispose(new Error("Invalid language detection response"))
        }
      } catch {
        return Promise.reject(new Error("Language detection unavailable"))
      }
    }
    const id = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const cancel = () => {
        this.pending.delete(id)
        clearTimeout(timer)
        signal.removeEventListener("abort", cancel)
        reject(new Error("Detection cancelled"))
        // Inference cannot be interrupted within TensorFlow. Releasing the last
        // owner terminates its work instead of accumulating an obsolete queue.
        if (!this.pending.size) this.dispose()
      }
      const timer = setTimeout(
        () => this.dispose(new Error("Language detection timed out")),
        20_000
      )
      signal.addEventListener("abort", cancel, { once: true })
      this.pending.set(id, {
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer)
          signal.removeEventListener("abort", cancel)
        },
      })
      this.worker!.postMessage({
        id,
        content: sample,
      })
    })
  }

  private releaseWhenIdle() {
    if (this.pending.size) return
    if (this.completed >= 16) this.dispose()
    else this.idle = setTimeout(() => this.dispose(), 60_000)
  }

  dispose(error = new Error("Language detection cancelled")) {
    clearTimeout(this.idle)
    this.worker?.terminate()
    this.worker = undefined
    this.completed = 0
    for (const request of this.pending.values()) {
      request.cleanup()
      request.reject(error)
    }
    this.pending.clear()
  }
}

export const contentLanguageDetection = new LanguageDetectionClient()
