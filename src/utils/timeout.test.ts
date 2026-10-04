import { describe, expect, test } from "bun:test"
import { withTimeout } from "./timeout"

describe("withTimeout", () => {
  test("resolves when the promise settles before the deadline", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 50, "too slow")).resolves.toBe("ok")
  })

  test("propagates a rejection that happens before the deadline", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 50, "too slow")).rejects.toThrow("boom")
  })

  test("rejects with the provided message once the deadline passes", async () => {
    const never = new Promise<string>(() => undefined)
    await expect(withTimeout(never, 10, "took too long")).rejects.toThrow("took too long")
  })
})
