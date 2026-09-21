import { describe, expect, test } from "bun:test"
import { FakeRerankService } from "./fake"

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
