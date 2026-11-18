import { describe, expect, test } from "bun:test"
import {
  aggregate,
  hitAtK,
  METRICS_VERSION,
  ndcgAtK,
  recallAtK,
  reciprocalRank,
  scoreQuery,
  uniqueDocumentIds
} from "./metrics"

describe("retrieval metrics", () => {
  test("version and stable document deduplication", () => {
    const input = Object.freeze(["b", "a", "b", "c", "a"])
    expect(METRICS_VERSION).toBe("document-v2")
    expect(uniqueDocumentIds(input)).toEqual(["b", "a", "c"])
    expect(uniqueDocumentIds(input)).not.toBe(input)
    expect(input).toEqual(["b", "a", "b", "c", "a"])
  })

  test("all metrics deduplicate documents before ranking and cutoff", () => {
    const retrieved = ["x", "x", "a", "a", "b"]
    const gold = ["a", "a", "b", "b"]
    expect(hitAtK(retrieved, gold, 2)).toBe(1)
    expect(recallAtK(retrieved, gold, 2)).toBe(0.5)
    expect(recallAtK(retrieved, gold, 3)).toBe(1)
    expect(reciprocalRank(retrieved, gold)).toBe(0.5)
    expect(ndcgAtK(retrieved, gold, 3)).toBe(ndcgAtK(["x", "a", "b"], ["a", "b"], 3))
    expect(ndcgAtK(["a", "a", "a"], ["a", "a"], 10)).toBe(1)
    expect(ndcgAtK(["a", "a", "x"], ["a", "b"], 2)).toBeCloseTo(1 / (1 + 1 / Math.log2(3)))
  })

  test("zero K and empty retrieved or gold inputs score zero", () => {
    for (const metric of [hitAtK, recallAtK, ndcgAtK]) {
      expect(metric(["a"], ["a"], 0)).toBe(0)
      expect(metric([], ["a"], 10)).toBe(0)
      expect(metric(["a"], [], 10)).toBe(0)
    }
    expect(reciprocalRank([], ["a"])).toBe(0)
    expect(reciprocalRank(["a"], [])).toBe(0)
    expect(Object.values(scoreQuery([], []))).toEqual(Array(8).fill(0))
  })

  test("K must be a nonnegative safe integer even for empty inputs", () => {
    for (const k of [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      for (const metric of [hitAtK, recallAtK, ndcgAtK]) {
        expect(() => metric([], [], k)).toThrow(RangeError)
      }
    }
    expect(ndcgAtK(["a"], ["a"], Number.MAX_SAFE_INTEGER)).toBe(1)
  })

  test("scoreQuery caps MRR at ten unique documents, reciprocalRank is generic", () => {
    const misses = Array.from({ length: 10 }, (_, index) => `miss-${index}`)
    expect(reciprocalRank([...misses, "gold"], ["gold"])).toBe(1 / 11)
    expect(scoreQuery([...misses, "gold"], ["gold"]).mrrAt10).toBe(0)
    expect(scoreQuery([...misses.slice(0, 9), "gold"], ["gold"]).mrrAt10).toBe(0.1)
    expect(scoreQuery([...Array(20).fill("miss"), "gold"], ["gold"]).mrrAt10).toBe(0.5)
    expect(scoreQuery(["gold"], ["gold"])).not.toHaveProperty("mrr")
  })

  test("all headline and aggregated scores stay within zero and one", () => {
    const scores = []
    const ids = ["a", "b", "c"]
    for (let encoding = 0; encoding < 729; encoding++) {
      let value = encoding
      const retrieved = Array.from({ length: 6 }, () => {
        const id = ids[value % 3]
        value = Math.floor(value / 3)
        return id
      })
      for (const gold of [[], ["a"], ["a", "a", "b"], ids]) {
        const score = scoreQuery(retrieved, gold)
        scores.push(score)
        for (const result of Object.values(score)) {
          expect(result).toBeGreaterThanOrEqual(0)
          expect(result).toBeLessThanOrEqual(1)
        }
      }
    }
    for (const result of Object.values(aggregate(scores))) {
      expect(result).toBeGreaterThanOrEqual(0)
      expect(result).toBeLessThanOrEqual(1)
    }
    expect(Object.values(aggregate([]))).toEqual(Array(8).fill(0))
    expect(aggregate([scoreQuery(["x", "a"], ["a"]), scoreQuery([], ["a"])]).mrrAt10).toBe(0.25)
  })

  test("hitAtK is 1 when any relevant id is in the window", () => {
    expect(hitAtK(["a", "b", "c"], ["c"], 2)).toBe(0)
    expect(hitAtK(["a", "b", "c"], ["c"], 3)).toBe(1)
  })

  test("recallAtK is the fraction of gold items recovered", () => {
    expect(recallAtK(["a", "x", "b"], ["a", "b", "c"], 2)).toBeCloseTo(1 / 3)
    expect(recallAtK(["a", "x", "b"], ["a", "b", "c"], 3)).toBeCloseTo(2 / 3)
  })

  test("MRR uses the rank of the first relevant hit", () => {
    expect(reciprocalRank(["x", "gold", "y"], ["gold"])).toBeCloseTo(0.5)
    expect(reciprocalRank(["x", "y"], ["gold"])).toBe(0)
  })

  test("NDCG@K is 1 for a perfect ranking", () => {
    expect(ndcgAtK(["a", "b", "c"], ["a", "b"], 10)).toBeCloseTo(1)
    expect(ndcgAtK(["x", "y"], ["a"], 10)).toBe(0)
  })

  test("scoreQuery bundles the headline metrics", () => {
    const score = scoreQuery(["doc-1", "doc-2", "doc-9"], ["doc-2"])
    expect(score.hitAt5).toBe(1)
    expect(score.mrrAt10).toBeCloseTo(0.5)
    expect(score.recallAt5).toBe(1)
    expect(score.hitAt1).toBe(0)
    expect(score.recallAt1).toBe(0)
  })

  test("recallAtK@1 counts only the top-ranked hit", () => {
    expect(recallAtK(["a", "b", "c"], ["a", "b"], 1)).toBeCloseTo(1 / 2)
    expect(recallAtK(["a", "b", "c"], ["a", "b"], 2)).toBe(1)
  })
})
