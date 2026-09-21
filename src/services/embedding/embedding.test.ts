import { describe, expect, test } from "bun:test"
import { FakeEmbeddingService } from "./fake"

describe("EmbeddingPort", () => {
  test("embedBatch returns one vector per input with the declared size", async () => {
    const embeddings = new FakeEmbeddingService(4)
    const vectors = await embeddings.embedBatch(["alpha", "beta"])

    expect(vectors).toHaveLength(2)
    expect(vectors[0]).toHaveLength(4)
    expect(vectors[1]).toHaveLength(4)
    expect(vectors[0]).not.toEqual(vectors[1])
  })

  test("embed is consistent with a single-item batch", async () => {
    const embeddings = new FakeEmbeddingService(4)
    const single = await embeddings.embed("same")
    const [fromBatch] = await embeddings.embedBatch(["same"])
    expect(single).toEqual(fromBatch)
  })
})
