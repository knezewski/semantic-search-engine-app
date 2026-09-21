import { describe, expect, test } from "bun:test"
import { CachedEmbeddingService } from "./cache"
import { FakeEmbeddingService } from "./fake"

describe("CachedEmbeddingService", () => {
  test("reuses a vector for the same query", async () => {
    const inner = new FakeEmbeddingService(4)
    const cached = new CachedEmbeddingService(inner, 8)
    const first = await cached.embed("jwt tokens")
    const second = await cached.embed("jwt tokens")
    expect(second).toEqual(first)
  })

  test("evicts the oldest entry when full", async () => {
    const inner = new FakeEmbeddingService(4)
    const cached = new CachedEmbeddingService(inner, 1)
    const alpha = await cached.embed("alpha")
    await cached.embed("beta")
    const alphaAgain = await cached.embed("alpha")
    expect(alphaAgain).toEqual(alpha)
  })
})
