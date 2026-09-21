import { describe, expect, test } from "bun:test"
import { termIndex, tokenize, toSparseVector } from "./sparse"

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

  test("hashes a term stably", () => {
    expect(termIndex("qdrant")).toBe(termIndex("qdrant"))
    expect(termIndex("qdrant")).not.toBe(termIndex("jwt"))
  })
})
