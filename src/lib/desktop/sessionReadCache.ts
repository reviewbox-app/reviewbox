/** Disposable webview reads; native captures remain authoritative. */
export class SessionReadCache<T> {
  private values = new Map<string, { value: T; touched: number }>()
  constructor(
    private limit = 3,
    private ttl = 15 * 60 * 1000
  ) {}
  get(key: string): T | undefined {
    const item = this.values.get(key)
    if (!item) return
    if (Date.now() - item.touched > this.ttl) {
      this.values.delete(key)
      return
    }
    this.values.delete(key)
    this.values.set(key, { ...item, touched: Date.now() })
    return item.value
  }
  set(key: string, value: T) {
    this.values.delete(key)
    this.values.set(key, { value, touched: Date.now() })
    while (this.values.size > this.limit) {
      const oldest = this.values.keys().next().value
      if (oldest === undefined) break
      this.values.delete(oldest)
    }
  }
}
