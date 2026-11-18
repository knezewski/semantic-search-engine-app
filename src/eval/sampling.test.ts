import { describe, expect, test } from "bun:test"
import { readIntegerOption, sampleQueries, seededRandom } from "./sampling"

describe("readIntegerOption", () => {
  const name = "EVAL_SAMPLING_INTEGER_TEST"
  const withEnv = (raw: string | undefined, run: () => void): void => {
    const previous = process.env[name]
    try {
      if (raw === undefined) delete process.env[name]
      else process.env[name] = raw
      run()
    } finally {
      if (previous === undefined) delete process.env[name]
      else process.env[name] = previous
    }
  }

  test("missing values use validated fallback; decimal signs and leading zeros are accepted", () => {
    withEnv(undefined, () => expect(readIntegerOption(name, 42)).toBe(42))
    for (const [raw, expected] of [
      ["0", 0],
      ["+12", 12],
      ["0012", 12],
      ["-2", -2]
    ] as const) {
      withEnv(raw, () => expect(readIntegerOption(name, 0, -2, 12)).toBe(expected))
    }
    withEnv(String(Number.MAX_SAFE_INTEGER), () => {
      expect(readIntegerOption(name, 0)).toBe(Number.MAX_SAFE_INTEGER)
    })
  })

  test("rejects empty, whitespace, fractions, exponents, hex, suffixes and unsafe values", () => {
    for (const raw of [
      "",
      " ",
      " 2",
      "2 ",
      "1.0",
      "1e2",
      "0x10",
      "2queries",
      "NaN",
      "Infinity",
      "1_000",
      "--1",
      "9007199254740992"
    ]) {
      withEnv(raw, () => expect(() => readIntegerOption(name, 0)).toThrow())
    }
    withEnv("-1", () => expect(() => readIntegerOption(name, 0)).toThrow(RangeError))
    withEnv("11", () => expect(() => readIntegerOption(name, 0, 0, 10)).toThrow(RangeError))
  })

  test("validates fallback and bounds whether or not an env value is present", () => {
    withEnv("2", () => {
      for (const fallback of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => readIntegerOption(name, fallback)).toThrow(RangeError)
      }
      expect(() => readIntegerOption(name, 0, 2, 1)).toThrow(RangeError)
      expect(() => readIntegerOption(name, 0, 0.5)).toThrow(RangeError)
      expect(() => readIntegerOption(name, 0, 0, Infinity)).toThrow(RangeError)
    })
  })
})

describe("seededRandom", () => {
  test("is reproducible, local, and follows Mulberry32", () => {
    const first = seededRandom(1)
    const second = seededRandom(1)
    expect(first()).toBe(0.6270739405881613)
    expect(second()).toBe(0.6270739405881613)
    for (let index = 0; index < 1000; index++) expect(first()).toBe(second())
    expect(seededRandom(1)()).not.toBe(seededRandom(2)())
    expect(seededRandom(-1)()).toBe(seededRandom(4294967295)())
    expect(seededRandom(0)()).toBe(seededRandom(4294967296)())
  })

  test("outputs are finite and in [0, 1)", () => {
    const random = seededRandom(0)
    for (let index = 0; index < 10000; index++) {
      const value = random()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })

  test("rejects invalid seeds", () => {
    for (const seed of [NaN, Infinity, -Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => seededRandom(seed)).toThrow(RangeError)
    }
  })
})

describe("sampleQueries", () => {
  test("partial Fisher-Yates samples are deterministic without replacement or mutation", () => {
    const items = Object.freeze(Array.from({ length: 20 }, (_, id) => ({ id })))
    const sample = sampleQueries(items, 7, 42)
    expect(sample).toHaveLength(7)
    expect(new Set(sample).size).toBe(7)
    expect(sample).toEqual(sampleQueries(items, 7, 42))
    expect(sample).not.toEqual(sampleQueries(items, 7, 43))
    expect(items.map(item => item.id)).toEqual(Array.from({ length: 20 }, (_, id) => id))
    for (const item of sample) expect(items.includes(item)).toBe(true)
  })

  test("zero and all-size caps return a distinct copy in original order", () => {
    const items = Object.freeze(["c", "b", "a", "a"])
    for (const cap of [0, 4, 5, Number.MAX_SAFE_INTEGER]) {
      const sampled = sampleQueries(items, cap, 42)
      expect(sampled).toEqual([...items])
      expect(sampled).not.toBe(items)
    }
    expect(sampleQueries([], 2, 0)).toEqual([])
    expect(sampleQueries(["a"], 1, 0)).toEqual(["a"])
  })

  test("validates caps and seeds even when returning all or empty items", () => {
    for (const cap of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => sampleQueries([], cap, 0)).toThrow(RangeError)
    }
    expect(() => sampleQueries([], 0, NaN)).toThrow(RangeError)
    expect(() => sampleQueries([1], 10, 0.5)).toThrow(RangeError)
  })
})
