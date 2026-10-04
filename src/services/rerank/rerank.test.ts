import { describe, expect, test } from "bun:test"
import { FakeRerankService } from "./fake"
import { readRerankScore } from "./index"

describe("FakeRerankService", () => {
  test("scores an exact query match higher than an unrelated passage", async () => {
    const rerank = new FakeRerankService()
    const scores = await rerank.score("jwt authentication", [
      "a lighthouse keeper writes letters",
      "JWT authentication allows a server to issue a signed token"
    ])
    expect(scores[1] ?? 0).toBeGreaterThan(scores[0] ?? 0)
  })
})

describe("readRerankScore", () => {
  test("returns the raw relevance logit without inverting it", () => {
    // Regression: a single-label cross-encoder emits one logit, whose softmax is
    // always 1.0. The old code inverted it when the label matched /neg|0/i,
    // turning every rerank score into 0 and disabling reranking entirely.
    expect(readRerankScore([6.72])).toBeCloseTo(6.72)
    expect(readRerankScore([-11.38])).toBeCloseTo(-11.38)
  })

  test("ranks a relevant passage above an irrelevant one", () => {
    const relevant = readRerankScore([6.72])
    const irrelevant = readRerankScore([-11.38])
    expect(relevant).toBeGreaterThan(irrelevant)
  })

  test("picks the relevant class for multi-label heads", () => {
    expect(readRerankScore([-1.5, 4.25])).toBeCloseTo(4.25)
  })

  test("returns 0 for an empty row", () => {
    expect(readRerankScore([])).toBe(0)
  })
})
