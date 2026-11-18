import { describe, expect, test } from "bun:test"
import { aggregate, scoreQuery } from "./metrics"
import { compareQueries, makeQueryResult, summarizeQueries } from "./report"
import { compareScores } from "./statistics"
import type { EvalQuery } from "./types"

const query = (id: string, text = "find a document", gold = ["a"]): EvalQuery => ({
  id,
  query: text,
  relevantDocumentIds: gold
})

describe("makeQueryResult", () => {
  test("preserves raw chunk order and full score precision while deduplicating document ranks", () => {
    const item = query("q1", "find gold", ["a", "a", "b"])
    const hits = [
      { documentId: "x", chunkId: "x-1", score: 0.9876543210987654, text: "private passage" },
      { documentId: "x", chunkId: "x-2", score: 0.9, text: "another private passage" },
      { documentId: "a", chunkId: "a-1", score: 0.12345678901234566, payload: { secret: "hidden" } },
      { documentId: "a", chunkId: "a-2" },
      { documentId: "b", chunkId: "b-1", score: -0.000000123456789 }
    ]
    const row = makeQueryResult(item, hits)
    expect(row.id).toBe("q1")
    expect(row.query).toBe(item.query)
    expect(row.relevantDocumentIds).toEqual(["a", "b"])
    expect(row.documentRanking).toEqual(["x", "a", "b"])
    expect(row.metrics).toEqual(scoreQuery(["x", "a", "b"], ["a", "b"]))
    expect(row.metrics.mrrAt10).toBe(0.5)
    expect(row.retrieved).toEqual([
      { rank: 1, documentId: "x", chunkId: "x-1", score: 0.9876543210987654 },
      { rank: 2, documentId: "x", chunkId: "x-2", score: 0.9 },
      { rank: 3, documentId: "a", chunkId: "a-1", score: 0.12345678901234566 },
      { rank: 4, documentId: "a", chunkId: "a-2" },
      { rank: 5, documentId: "b", chunkId: "b-1", score: -0.000000123456789 }
    ])
    const persisted = JSON.parse(JSON.stringify(row))
    expect(persisted.retrieved[2].score).toBe(hits[2].score)
    expect(JSON.stringify(row)).not.toContain("private passage")
    expect(JSON.stringify(row)).not.toContain("hidden")
    expect(item.relevantDocumentIds).toEqual(["a", "a", "b"])
    expect(hits[0]).not.toHaveProperty("rank")
  })

  test("scores only the returned chunk window without inventing document backfill", () => {
    const row = makeQueryResult(query("q1", "find both", ["a", "b"]), [
      { documentId: "a", chunkId: "a-1" },
      { documentId: "a", chunkId: "a-2" }
    ])
    expect(row.retrieved).toHaveLength(2)
    expect(row.documentRanking).toEqual(["a"])
    expect(row.metrics.recallAt10).toBe(0.5)
    expect(row.metrics.ndcgAt10).toBe(1 / (1 + 1 / Math.log2(3)))
  })

  test("copies degradation and timings, including fractional timings", () => {
    const degraded = ["reranker-fallback", "dense-unavailable"]
    const timingMs = { retrieval: 1.234567890123, rerank: 0.000123456789 }
    const row = makeQueryResult(query("q1"), [], { degraded, timingMs })
    expect(row.degraded).toEqual(degraded)
    expect(row.timingMs).toEqual(timingMs)
    degraded.push("later")
    timingMs.retrieval = 99
    expect(row.degraded).toEqual(["reranker-fallback", "dense-unavailable"])
    expect(row.timingMs.retrieval).toBe(1.234567890123)
    expect(makeQueryResult(query("q2"), []).degraded).toEqual([])
    expect(makeQueryResult(query("q2"), []).timingMs).toEqual({})
  })

  test("empty or unanswerable results retain evidence and have zero metrics", () => {
    const empty = makeQueryResult(query("empty"), [])
    const noGold = makeQueryResult(query("unanswerable", "nothing matches", []), [{ documentId: "x", chunkId: "x-1" }])
    expect(empty.retrieved).toEqual([])
    expect(empty.documentRanking).toEqual([])
    expect(noGold.retrieved).toHaveLength(1)
    expect(Object.values(empty.metrics)).toEqual(Array(8).fill(0))
    expect(Object.values(noGold.metrics)).toEqual(Array(8).fill(0))
  })

  test("rejects blank identifiers and nonfinite scores without rejecting zero or negatives", () => {
    for (const hit of [
      { documentId: "", chunkId: "c" },
      { documentId: "  ", chunkId: "c" },
      { documentId: "a", chunkId: "" },
      { documentId: "a", chunkId: "\t" }
    ])
      expect(() => makeQueryResult(query("q"), [hit])).toThrow("Missing document/chunk ID")
    for (const score of [NaN, Infinity, -Infinity]) {
      expect(() => makeQueryResult(query("q"), [{ documentId: "a", chunkId: "c", score }])).toThrow("Nonfinite")
    }
    expect(makeQueryResult(query("q"), [{ documentId: "a", chunkId: "c", score: 0 }]).retrieved[0].score).toBe(0)
  })
})

describe("summarizeQueries", () => {
  test("aggregates all rows and slices by unique gold count, word count, and degradation", () => {
    const rows = [
      makeQueryResult(query("q0", " short query ", []), []),
      makeQueryResult(query("q1", "one two three four five", ["a", "a"]), [{ documentId: "a", chunkId: "a-1" }]),
      makeQueryResult(query("q2", "one two three four five six", ["a", "b"]), [], { degraded: ["fallback"] }),
      makeQueryResult(query("q3", "one two three four five six seven eight nine", ["a", "b", "c"]), []),
      makeQueryResult(query("q4", "one two three four five six seven eight nine ten", ["a", "b", "c", "d"]), [], {
        degraded: ["fallback", "timeout"]
      })
    ]
    const summary = summarizeQueries(rows)
    expect(summary.n).toBe(5)
    expect(summary.degradedQueries).toBe(2)
    expect(summary.metrics).toEqual(aggregate(rows.map(row => row.metrics)))
    const expected: Record<string, number[]> = {
      "gold-count:0": [0],
      "gold-count:1": [1],
      "gold-count:2-3": [2, 3],
      "gold-count:4+": [4],
      "query-words:1-5": [0, 1],
      "query-words:6-9": [2, 3],
      "query-words:10+": [4],
      "execution:healthy": [0, 1, 3],
      "execution:degraded": [2, 4]
    }
    expect(Object.keys(summary.slices).sort()).toEqual(Object.keys(expected).sort())
    for (const [label, indices] of Object.entries(expected)) {
      expect(summary.slices[label]).toEqual({
        n: indices.length,
        metrics: aggregate(indices.map(index => rows[index].metrics))
      })
    }
  })

  test("does not silently summarize an empty evaluation", () => {
    expect(() => summarizeQueries([])).toThrow("empty evaluation")
  })
})

describe("compareQueries", () => {
  test("compares identically ordered query pairs using full precision", () => {
    const baseline = [makeQueryResult(query("q1"), []), makeQueryResult(query("q2"), [])]
    const variant = [
      makeQueryResult(query("q1"), [{ documentId: "a", chunkId: "a-1" }]),
      makeQueryResult(query("q2"), [
        { documentId: "x", chunkId: "x-1" },
        { documentId: "a", chunkId: "a-1" }
      ])
    ]
    const options = { seed: 4, resamples: 21, confidence: 0.8 }
    expect(compareQueries(baseline, variant, options)).toEqual(
      compareScores(
        baseline.map(row => row.metrics),
        variant.map(row => row.metrics),
        options
      )
    )
    expect(compareQueries(baseline, variant, options).mrrAt10.delta).toBe(0.75)
  })

  test("rejects mismatched, reordered, missing, or duplicate paired IDs", () => {
    const q1 = makeQueryResult(query("q1"), [])
    const q2 = makeQueryResult(query("q2"), [])
    for (const [baseline, variant] of [
      [[q1], [q2]],
      [
        [q1, q2],
        [q2, q1]
      ],
      [[q1], [q1, q2]],
      [
        [q1, q1],
        [q1, q2]
      ],
      [
        [q1, q2],
        [q1, q1]
      ],
      [
        [q1, q1],
        [q1, q1]
      ]
    ])
      expect(() => compareQueries(baseline, variant)).toThrow("identical unique query IDs")
    expect(() => compareQueries([], [])).toThrow()
  })
})
