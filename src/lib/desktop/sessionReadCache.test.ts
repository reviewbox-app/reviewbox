import { expect, test } from "bun:test"
import { SessionReadCache } from "./sessionReadCache"

test("session reads retain recent entries and evict the least recently used", () => {
  const cache = new SessionReadCache<string>(2)
  cache.set("a", "first")
  cache.set("b", "second")
  expect(cache.get("a")).toBe("first")
  cache.set("c", "third")
  expect(cache.get("b")).toBeUndefined()
  expect(cache.get("a")).toBe("first")
})
test("expired values are not offered as an immediate snapshot", () => {
  const cache = new SessionReadCache<string>(2, -1)
  cache.set("a", "expired")
  expect(cache.get("a")).toBeUndefined()
})
