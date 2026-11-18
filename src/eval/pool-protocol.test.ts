import { describe, expect, test } from "bun:test"
import { runLatencyBenchmark } from "./latency-benchmark"
import { scoreQuery } from "./metrics"
import {
  measurePoolPath,
  parsePoolProtocol,
  type PoolCandidate,
  type PoolPorts,
  preparePoolQuery,
  scorePool
} from "./pool-protocol"

const item = { id: "q", query: "query", relevantDocumentIds: ["d15"] }
const candidates = (n: number): PoolCandidate[] =>
  Array.from({ length: n }, (_, index) => ({
    documentId: `d${index + 1}`,
    chunkId: `c${index + 1}`,
    text: `secret passage ${index + 1}`,
    score: 1 - index / 100
  }))
const fake = () => {
  const depths: number[] = []
  const batches: string[][] = []
  const embeds: string[] = []
  const ports: PoolPorts = {
    embed: async query => {
      embeds.push(query)
      return [1]
    },
    search: async (_vector, depth) => {
      depths.push(depth)
      return candidates(depth)
    },
    score: async (_query, passages) => {
      batches.push([...passages])
      return passages.map((_, index) => index)
    }
  }
  return { ports, depths, batches, embeds }
}

describe("independent pool protocol", () => {
  test("defaults to fixed-candidates and rejects legacy and unknown modes", () => {
    expect(parsePoolProtocol()).toBe("fixed-candidates")
    expect(parsePoolProtocol("serving-depth")).toBe("serving-depth")
    for (const value of ["reuse-top50", "", "other"]) expect(() => parsePoolProtocol(value)).toThrow()
  })
  test("embeds/retrieves once but independently scores every fixed prefix", async () => {
    const f = fake()
    const r = await preparePoolQuery(item, f.ports, parsePoolProtocol())
    expect(f.embeds).toEqual(["query"])
    expect(f.depths).toEqual([50])
    expect(f.batches.map(batch => batch.length)).toEqual([15, 30, 50])
    expect(r.variants.map(v => v.queryResult.retrieved[0].chunkId)).toEqual(["c15", "c30", "c50"])
    expect(r.baseline.retrieved.map(hit => hit.chunkId)).toEqual(candidates(10).map(c => c.chunkId))
    expect(r.baselineCandidates).toHaveLength(50)
  })
  test("batch-dependent scorer proves scores are not sliced from top50", async () => {
    const f = fake()
    f.ports.score = async (_q, passages) => passages.map((_, i) => (passages.length === 15 ? -i : i))
    const r = await preparePoolQuery(item, f.ports, "fixed-candidates")
    expect(r.variants[0].queryResult.retrieved[0].chunkId).toBe("c1")
    expect(r.variants[2].queryResult.retrieved[0].chunkId).toBe("c50")
  })
  test("serving-depth separately retrieves baseline and each pool", async () => {
    const f = fake()
    f.ports.search = async (_vector, depth) => {
      f.depths.push(depth)
      return candidates(depth).map(c => ({ ...c, chunkId: `${depth}-${c.chunkId}` }))
    }
    const r = await preparePoolQuery(item, f.ports, "serving-depth")
    expect(f.depths).toEqual([10, 15, 30, 50])
    expect(f.batches.map(batch => batch.length)).toEqual([15, 30, 50])
    expect(r.baseline.retrieved[0].chunkId).toBe("10-c1")
    expect(r.variants[0].queryResult.retrieved[0].chunkId).toBe("15-c15")
  })
  test("complete raw evidence reconstructs ranked output/metrics without passages", async () => {
    const { variants } = await preparePoolQuery(item, fake().ports, "fixed-candidates")
    for (const variant of variants) {
      expect(variant.candidateScores).toHaveLength(variant.pool)
      for (const [index, c] of variant.candidateScores.entries()) {
        expect(c.denseRank).toBe(index + 1)
        expect(c.denseScore).toBe(candidates(variant.pool)[index].score)
        expect(c.textSha256).toMatch(/^[0-9a-f]{64}$/)
      }
      expect(JSON.stringify(variant.candidateScores)).not.toContain("secret passage")
      const ranked = [...variant.candidateScores]
        .sort((a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0) || a.denseRank - b.denseRank)
        .slice(0, 10)
      expect(ranked.map(c => c.chunkId)).toEqual(variant.queryResult.retrieved.map(c => c.chunkId))
      expect(
        scoreQuery(
          ranked.map(c => c.documentId),
          item.relevantDocumentIds
        )
      ).toEqual(variant.queryResult.metrics)
    }
  })
  test("deterministic ties preserve dense order, including duplicate documents", async () => {
    const f = fake()
    f.ports.score = async (_q, passages) => passages.map(() => 0)
    const input = candidates(15).map(c => ({ ...c, documentId: "same" }))
    const result = await scorePool(item, input, f.ports)
    expect(result.queryResult.retrieved.map(c => c.chunkId)).toEqual(candidates(10).map(c => c.chunkId))
    expect(result.queryResult.documentRanking).toEqual(["same"])
  })
  test("rejects missing/excess/nonfinite scores", async () => {
    for (const scores of [[0], [0, 1, 2], [0, Number.NaN], [0, Infinity]]) {
      const f = fake()
      f.ports.score = async () => scores
      await expect(scorePool(item, candidates(2), f.ports)).rejects.toThrow("Invalid reranker scores")
    }
  })
  test("rejects invalid candidate evidence before scoring", async () => {
    for (const rows of [
      [{ ...candidates(1)[0], score: Infinity }],
      [{ ...candidates(1)[0], chunkId: "" }],
      [{ ...candidates(1)[0], documentId: "" }],
      [{ ...candidates(1)[0], text: "" }],
      [candidates(1)[0], candidates(1)[0]]
    ])
      await expect(scorePool(item, rows, fake().ports)).rejects.toThrow()
    const f = fake()
    f.ports.search = async () => candidates(51)
    await expect(preparePoolQuery(item, f.ports, "fixed-candidates")).rejects.toThrow()
  })
  test("empty retrieval is valid zero-quality and does not call scorer", async () => {
    const f = fake()
    f.ports.search = async () => []
    const r = await preparePoolQuery(item, f.ports, "fixed-candidates")
    expect(f.batches).toHaveLength(0)
    expect(r.variants[0].queryResult.metrics.ndcgAt10).toBe(0)
  })
  test("repeated latency integrates the real pool path without reusing scores", async () => {
    const f = fake()
    const result = await runLatencyBenchmark({
      items: [
        { ...item, id: "q1" },
        { ...item, id: "q2" }
      ],
      pools: [15, 30, 50],
      repeats: 2,
      warmupRounds: 1,
      seed: 42,
      run: (query, pool) => measurePoolPath(query, pool, f.ports, "fixed-candidates")
    })
    expect(f.embeds).toHaveLength(18)
    expect(f.depths).toEqual(Array(18).fill(50))
    expect(f.batches).toHaveLength(18)
    expect(result.samples).toHaveLength(12)
    for (const summary of result.summaries) {
      expect(summary.n).toBe(4)
      expect(summary.perRepeat.map(repeat => repeat.n)).toEqual([2, 2])
      expect(Object.keys(summary.stagesMs).sort()).toEqual(["embed", "endToEnd", "rerank", "retrieval"])
    }
  })
  test("latency path really embeds/retrieves/scores each pool and exposes stages", async () => {
    for (const protocol of ["fixed-candidates", "serving-depth"] as const) {
      const f = fake()
      const result = await measurePoolPath(item, 15, f.ports, protocol)
      expect(f.depths).toEqual([protocol === "fixed-candidates" ? 50 : 15])
      expect(f.batches.map(b => b.length)).toEqual([15])
      expect(result.candidates).toBe(15)
      for (const stage of Object.values(result.stagesMs)) expect(stage).toBeGreaterThanOrEqual(0)
    }
  })
})
