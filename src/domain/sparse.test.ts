import { describe, expect, test } from "bun:test"
import { termIndex, toDocumentSparseVector, tokenize, toSparseVector } from "./sparse"

describe("sparse BM25 tokens", () => {
  test("lowercases and drops short tokens", () => {
    expect(tokenize("JWT authentication allows a server")).toEqual(["jwt", "authentication", "allows", "server"])
  })

  test("builds sorted unique sparse indices with term frequencies", () => {
    const sparse = toSparseVector("token token vector")
    expect(sparse.indices).toHaveLength(2)
    expect(sparse.indices).toEqual([...sparse.indices].sort((a, b) => a - b))
    expect(sparse.values).toContain(2)
    expect(sparse.values).toContain(1)
  })

  test("bm25 weighting saturates repeated terms and penalises long documents", () => {
    const tf = toDocumentSparseVector("alpha beta", "tf", 10)
    const bm25Short = toDocumentSparseVector("alpha beta", "bm25", 10)
    const bm25Long = toDocumentSparseVector(`alpha beta ${"gamma ".repeat(40)}`, "bm25", 10)
    const bm25Repeated = toDocumentSparseVector("alpha alpha alpha alpha", "bm25", 10)

    expect(tf.values).toEqual([1, 1])
    expect(bm25Short.values.every(value => value > 0 && value < 2.2)).toBe(true)
    const alphaIndex = termIndex("alpha")
    const weightOf = (vector: { indices: number[]; values: number[] }, index: number) =>
      vector.values[vector.indices.indexOf(index)] ?? 0
    expect(weightOf(bm25Long, alphaIndex)).toBeLessThan(weightOf(bm25Short, alphaIndex))
    expect(weightOf(bm25Repeated, alphaIndex)).toBeGreaterThan(weightOf(bm25Short, alphaIndex))
    expect(weightOf(bm25Repeated, alphaIndex)).toBeLessThan(4 * weightOf(bm25Short, alphaIndex))
  })

  test("hashes a term stably", () => {
    expect(termIndex("qdrant")).toBe(termIndex("qdrant"))
    expect(termIndex("qdrant")).not.toBe(termIndex("jwt"))
  })
})
