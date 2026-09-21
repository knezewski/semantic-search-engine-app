import { describe, expect, test } from "bun:test"
import { hitAtK, ndcgAtK, recallAtK, reciprocalRank, scoreQuery } from "./metrics"

describe("retrieval metrics", () => {
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
    expect(score.mrr).toBeCloseTo(0.5)
    expect(score.recallAt5).toBe(1)
  })
})
