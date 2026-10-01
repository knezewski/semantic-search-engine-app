import { describe, expect, test } from "bun:test"
import { CircuitBreaker } from "./circuit-breaker"

describe("CircuitBreaker", () => {
  test("passes through successful calls and stays closed", async () => {
    const breaker = new CircuitBreaker({ threshold: 2 })
    expect(await breaker.run(async () => "ok")).toBe("ok")
    expect(breaker.isOpen).toBe(false)
  })

  test("opens after the configured number of consecutive failures", async () => {
    const breaker = new CircuitBreaker({ threshold: 2 })
    await breaker
      .run(async () => {
        throw new Error("boom")
      })
      .catch(() => {})
    expect(breaker.isOpen).toBe(false)

    await breaker
      .run(async () => {
        throw new Error("boom")
      })
      .catch(() => {})
    expect(breaker.isOpen).toBe(true)
  })

  test("fails fast without invoking the action while open", async () => {
    const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 60_000 })
    await breaker
      .run(async () => {
        throw new Error("boom")
      })
      .catch(() => {})

    let called = false
    await expect(
      breaker.run(async () => {
        called = true
        return "unexpected"
      })
    ).rejects.toThrow("Circuit breaker is open")
    expect(called).toBe(false)
  })
})
