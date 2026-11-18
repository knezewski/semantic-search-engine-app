import { describe, expect, test } from "bun:test"
import type { SearchQuery, TimedSearchResult } from "../services/search"
import { loadJson } from "./fixtures"
import { parseModelRevisions } from "./models"
import { evaluateMode } from "./run"
import { validateFixtures } from "./run-context"
import type { EvalDocument, EvalQuery } from "./types"

const dataset: EvalQuery[] = [
  { id: "q1", query: "Find relevant evidence", relevantDocumentIds: ["gold"] },
  { id: "q2", query: "Missing evidence", relevantDocumentIds: ["gold"] }
]

const hit = (documentId: string, chunkId: string) => ({
  documentId,
  chunkId,
  text: "private passage",
  score: 0.987654321,
  title: "test",
  source: null,
  position: 0
})

describe("offline evaluation runner integration", () => {
  test("preserves ranked evidence, full precision, pair order and fallback signals", async () => {
    const calls: SearchQuery[] = []
    const search = {
      async searchTimed(input: SearchQuery): Promise<TimedSearchResult> {
        calls.push(input)
        return {
          hits: input.query === dataset[0].query ? [hit("gold", "g1"), hit("gold", "g2")] : [],
          mode: "dense",
          embedMs: 0.123456789,
          qdrantMs: 2.25,
          rerankMs: 0,
          totalMs: 2.373456789,
          degraded: input.query === dataset[1].query ? ["qdrant"] : []
        }
      }
    }
    const result = await evaluateMode(search, dataset, "dense")
    expect(calls).toEqual(dataset.map(item => ({ query: item.query, limit: 10, mode: "dense" })))
    expect(result.queryResults.map(row => row.id)).toEqual(["q1", "q2"])
    expect(result.queryResults[0].documentRanking).toEqual(["gold"])
    expect(result.queryResults[0].retrieved.map(row => row.chunkId)).toEqual(["g1", "g2"])
    expect(result.queryResults[0].metrics.ndcgAt10).toBe(1)
    expect(result.queryResults[0].timingMs.embed).toBe(0.123456789)
    expect(result.metrics.ndcgAt10).toBe(0.5)
    expect(result.metrics.mrrAt10).toBe(0.5)
    expect(result.degradedQueries).toBe(1)
    expect(result.queryResults[1].degraded).toEqual(["qdrant"])
    expect(JSON.stringify(result)).not.toContain("private passage")
  })

  test("fixture loader resolves the default built-in smoke dataset without network", async () => {
    const corpus = await loadJson<EvalDocument[]>("corpus.json")
    const queries = await loadJson<EvalQuery[]>("dataset.json")
    expect(() => validateFixtures(corpus, queries)).not.toThrow()
    expect(corpus.length).toBeGreaterThan(0)
    expect(queries.length).toBeGreaterThan(0)
  })
})

describe("per-repository model revisions", () => {
  test("preserves different immutable revisions for different model repositories", () => {
    const revisions = {
      "BAAI/bge-small-en-v1.5": "a".repeat(40),
      "Xenova/all-MiniLM-L6-v2": "b".repeat(40)
    }
    expect(parseModelRevisions(JSON.stringify(revisions))).toEqual(revisions)
    expect(parseModelRevisions("{}")).toEqual({})
  })

  test("rejects malformed mappings and invalid or unknown repository revisions", () => {
    for (const raw of [
      "",
      "null",
      "[]",
      "false",
      "not-json",
      '{"unknown":"main"}',
      '{"BAAI/bge-small-en-v1.5":0}',
      '{"BAAI/bge-small-en-v1.5":""}',
      '{"BAAI/bge-small-en-v1.5":" main "}',
      '{"BAAI/bge-small-en-v1.5":"a b"}'
    ]) {
      expect(() => parseModelRevisions(raw)).toThrow()
    }
  })
})
