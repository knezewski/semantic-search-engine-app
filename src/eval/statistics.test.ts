import { describe, expect, test } from "bun:test"
import type { QueryScore } from "./metrics"
import { scoreQuery } from "./metrics"
import { compareScores, pairedBootstrap } from "./statistics"

describe("pairedBootstrap", () => {
  test("reports deterministic defaults and an unrounded paired mean delta", () => {
    const baseline = Object.freeze([0.1, 0.2, 0.4])
    const variant = Object.freeze([0.2, 0.6, 0.5])
    const result = pairedBootstrap(baseline, variant)
    expect(result).toEqual(pairedBootstrap(baseline, variant))
    expect(result.delta).toBeCloseTo(0.2, 15)
    expect(result).toMatchObject({ confidence: 0.95, resamples: 10_000, seed: 42, n: 3 })
    expect(result.lower).toBeLessThanOrEqual(result.upper)
    expect(baseline).toEqual([0.1, 0.2, 0.4])
    expect(variant).toEqual([0.2, 0.6, 0.5])
  })

  test("resamples paired rows rather than independently sampling each system", () => {
    const result = pairedBootstrap([0, 100, -100, 1000], [1, 101, -99, 1001], { resamples: 100 })
    expect(result.delta).toBe(1)
    expect(result.lower).toBe(1)
    expect(result.upper).toBe(1)
    const identical = pairedBootstrap([0.2, 0.8, 0.5], [0.2, 0.8, 0.5])
    expect(identical.delta).toBe(0)
    expect(identical.lower).toBe(0)
    expect(identical.upper).toBe(0)
  })

  test("uses interpolated percentile endpoints, not a normal approximation", () => {
    // Mulberry32(1) draws paired indices [1, 0] and [1, 1]. Means: 0.5, 1.
    const result = pairedBootstrap([0, 0], [0, 1], { seed: 1, resamples: 2, confidence: 0.5 })
    expect(result).toEqual({ delta: 0.5, lower: 0.625, upper: 0.875, confidence: 0.5, resamples: 2, seed: 1, n: 2 })
  })

  test("supports one observation, negative deltas, and a single resample", () => {
    expect(pairedBootstrap([0.75], [0.25], { seed: 0, resamples: 1, confidence: 0.9 })).toEqual({
      delta: -0.5,
      lower: -0.5,
      upper: -0.5,
      confidence: 0.9,
      resamples: 1,
      seed: 0,
      n: 1
    })
    const result = pairedBootstrap([0, 1, 2], [-1, 0, 1], { resamples: 10 })
    expect(result.delta).toBe(-1)
    expect(result.lower).toBe(-1)
    expect(result.upper).toBe(-1)
  })

  test("preserves precision and handles large finite means without sum overflow", () => {
    expect(pairedBootstrap([0], [1 / 3]).delta).toBe(1 / 3)
    const result = pairedBootstrap([0, 0], [Number.MAX_VALUE, Number.MAX_VALUE], { resamples: 10 })
    expect(result.delta).toBe(Number.MAX_VALUE)
    expect(result.lower).toBe(Number.MAX_VALUE)
    expect(result.upper).toBe(Number.MAX_VALUE)
    expect(() => pairedBootstrap([-Number.MAX_VALUE], [Number.MAX_VALUE])).toThrow(RangeError)
  })

  test("seed controls resampling reproducibly", () => {
    const baseline = [0, 0, 0, 0, 0]
    const variant = [0, 1, 5, 20, 100]
    const options = { seed: 11, resamples: 17, confidence: 0.8 }
    const result = pairedBootstrap(baseline, variant, options)
    expect(result).toEqual(pairedBootstrap(baseline, variant, options))
    expect(result).not.toEqual(pairedBootstrap(baseline, variant, { ...options, seed: 12 }))
    expect(result.delta).toBe(pairedBootstrap(baseline, variant, { seed: 12 }).delta)
  })

  test("validates nonempty equal lengths and every observation", () => {
    for (const [baseline, variant] of [
      [[], []],
      [[1], []],
      [[], [1]],
      [[1], [1, 2]]
    ]) {
      expect(() => pairedBootstrap(baseline, variant)).toThrow(RangeError)
    }
    for (const invalid of [NaN, Infinity, -Infinity]) {
      expect(() => pairedBootstrap([invalid], [1])).toThrow(TypeError)
      expect(() => pairedBootstrap([1], [invalid])).toThrow(TypeError)
    }
    expect(() => pairedBootstrap(new Array(2), [1, 2])).toThrow(TypeError)
  })

  test("validates options", () => {
    for (const resamples of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => pairedBootstrap([0], [1], { resamples })).toThrow(RangeError)
    }
    for (const confidence of [0, 1, -0.1, 1.1, NaN, Infinity]) {
      expect(() => pairedBootstrap([0], [1], { confidence })).toThrow(RangeError)
    }
    for (const seed of [0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => pairedBootstrap([0], [1], { seed })).toThrow(RangeError)
    }
  })
})

describe("compareScores", () => {
  test("compares all eight metrics, including mrrAt10, with the supplied paired options", () => {
    const baseline = Object.freeze([scoreQuery(["x", "a"], ["a"]), scoreQuery([], ["b"])])
    const variant = Object.freeze([scoreQuery(["a"], ["a"]), scoreQuery(["x", "b"], ["b"])])
    const options = { seed: 7, resamples: 31, confidence: 0.8 }
    const result = compareScores(baseline, variant, options)
    expect(Object.keys(result).sort()).toEqual(Object.keys(baseline[0]).sort())
    for (const metric of Object.keys(result) as (keyof QueryScore)[]) {
      expect(result[metric]).toEqual(
        pairedBootstrap(
          baseline.map(score => score[metric]),
          variant.map(score => score[metric]),
          options
        )
      )
    }
    expect(result.mrrAt10.delta).toBe(0.5)
    expect(result).not.toHaveProperty("mrr")
  })

  test("passes through default options and validates pairing and every metric", () => {
    const score = scoreQuery(["a"], ["a"])
    expect(compareScores([score], [score]).mrrAt10).toEqual(pairedBootstrap([1], [1]))
    expect(() => compareScores([], [])).toThrow(RangeError)
    expect(() => compareScores([score], [])).toThrow(RangeError)
    expect(() => compareScores([score], [{ ...score, ndcgAt10: NaN }])).toThrow(TypeError)
    expect(() => compareScores([{ ...score, recallAt5: Infinity }], [score])).toThrow(TypeError)
  })
})
