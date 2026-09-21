import { describe, expect, test } from "bun:test"
import { percentile } from "./percentile"

describe("percentile", () => {
  test("returns 0 for an empty list", () => {
    expect(percentile([], 95)).toBe(0)
  })

  test("returns the only value", () => {
    expect(percentile([10], 95)).toBe(10)
  })

  test("interpolates between ranks", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBeCloseTo(2.5)
    expect(percentile([1, 2, 3, 4], 100)).toBe(4)
  })
})
