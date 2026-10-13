import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { getQdrantClient, verifyQdrantConnection } from "../db/qdrant.client"
import { getEmbeddingService } from "../services/embedding"
import { getRerankService } from "../services/rerank"
import { VectorService } from "../services/vector"
import { summarize } from "../utils/percentile"
import { evalCollection, loadJson } from "./fixtures"
import { indexCorpus, payloadString, qualitySummary } from "./helpers"
import { aggregate, scoreQuery } from "./metrics"
import type { EvalDocument, EvalQuery } from "./types"

/**
 * Sweeps the rerank candidate pool size. Quality is measured by scoring the
 * dense top-50 once per query, then slicing to each pool size (cross-encoder
 * scores are independent per passage, so this is exact). Latency is measured
 * separately with real rerank runs over a sample of queries.
 *
 * Run: EVAL_FIXTURE_SET=fiqa-hn bun run eval:rerank-pool
 */

const COLLECTION = evalCollection()
const SEARCH_LIMIT = 10
const POOLS = [15, 30, 50] as const
const MAX_POOL = 50
const LATENCY_SAMPLE = 20
// Cap the number of queries scored (0 = all). The cross-encoder runs in wasm
// here (~seconds/query), so a subset keeps the sweep tractable.
const QUERY_CAP = Number.parseInt(process.env.EVAL_RERANK_QUERIES ?? "0", 10)

interface Candidate {
  documentId: string
  text: string
}

interface ScoredCandidate extends Candidate {
  score: number
  denseRank: number
}

const toCandidates = (points: Awaited<ReturnType<VectorService["searchChunks"]>>): Candidate[] =>
  points.map(point => ({
    documentId: payloadString(point.payload, "documentId"),
    text: payloadString(point.payload, "text")
  }))

const run = async (): Promise<void> => {
  await verifyQdrantConnection()
  const corpus = await loadJson<EvalDocument[]>("corpus.json")
  const dataset = await loadJson<EvalQuery[]>("dataset.json")
  const subset = QUERY_CAP > 0 ? dataset.slice(0, QUERY_CAP) : dataset

  const qdrant = getQdrantClient()
  const vectors = new VectorService(qdrant, COLLECTION)

  console.log(`Indexing ${corpus.length} eval documents into ${COLLECTION}`)
  await indexCorpus(corpus, vectors, COLLECTION)

  const embeddings = getEmbeddingService()
  const rerank = getRerankService()
  // Force the cross-encoder to load before we start timing.
  await rerank.score("warmup", ["warmup passage"])

  // Quality pass: score dense top-50 once per query, then slice per pool size.
  console.log(`Scoring dense top-${MAX_POOL} per query for ${subset.length} queries`)
  const perQuery: Array<{
    query: string
    relevant: string[]
    candidates: Candidate[]
    scored: ScoredCandidate[]
  }> = []

  for (const item of subset) {
    const queryVector = await embeddings.embed(item.query)
    const points = await vectors.searchChunks({ vector: queryVector, limit: MAX_POOL })
    const candidates = toCandidates(points)
    const scores = await rerank.score(
      item.query,
      candidates.map(candidate => candidate.text)
    )
    const scored = candidates.map((candidate, index) => ({
      ...candidate,
      score: scores[index] ?? 0,
      denseRank: index
    }))
    perQuery.push({ query: item.query, relevant: item.relevantDocumentIds, candidates, scored })
  }

  // Dense baseline (no rerank) for reference.
  const denseBaseline = qualitySummary(
    aggregate(
      perQuery.map(query =>
        scoreQuery(
          query.scored.slice(0, SEARCH_LIMIT).map(candidate => candidate.documentId),
          query.relevant
        )
      )
    )
  )

  // Quality per pool: rerank only the top-`pool` dense candidates.
  const qualityPerPool = POOLS.map(pool => {
    const scores = perQuery.map(query => {
      const reranked = query.scored
        .slice(0, pool)
        .sort((a, b) => b.score - a.score)
        .slice(0, SEARCH_LIMIT)
        .map(candidate => candidate.documentId)
      return scoreQuery(reranked, query.relevant)
    })
    return { pool, ...qualitySummary(aggregate(scores)) }
  })

  // Latency per pool: real rerank runs over a sample for accurate timing.
  console.log(`Sampling rerank latency over ${LATENCY_SAMPLE} queries`)
  const sample = perQuery.slice(0, LATENCY_SAMPLE)
  const latencyPerPool: Array<{ pool: number; p50: number; p95: number }> = []
  for (const pool of POOLS) {
    const latencies: number[] = []
    for (const query of sample) {
      const candidates = query.candidates.slice(0, pool)
      const started = performance.now()
      await rerank.score(
        query.query,
        candidates.map(candidate => candidate.text)
      )
      latencies.push(performance.now() - started)
    }
    const timing = summarize(latencies)
    latencyPerPool.push({ pool, p50: Number(timing.p50.toFixed(2)), p95: Number(timing.p95.toFixed(2)) })
  }

  const results = {
    collection: COLLECTION,
    model: getEmbeddingService().modelId,
    reranker: rerank.modelId,
    documents: corpus.length,
    queries: subset.length,
    queryCap: QUERY_CAP,
    searchLimit: SEARCH_LIMIT,
    maxPool: MAX_POOL,
    denseBaseline,
    pools: qualityPerPool.map((pool, index) => ({
      ...pool,
      latencyMs: latencyPerPool[index]
    }))
  }

  const outPath = join(import.meta.dir, "../../eval-rerank-pool-results.json")
  await mkdir(dirname(outPath), { recursive: true })
  await Bun.write(outPath, `${JSON.stringify(results, null, 2)}\n`)

  console.log("\nDense baseline:", JSON.stringify(denseBaseline))
  for (const pool of results.pools) {
    console.log(`pool=${pool.pool} →`, JSON.stringify(pool))
  }
  console.log(`Wrote ${outPath}`)
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
