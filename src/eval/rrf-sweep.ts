import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { getQdrantClient, verifyQdrantConnection } from "../db/qdrant.client"
import { toSparseVector } from "../domain/sparse"
import { getEmbeddingService } from "../services/embedding"
import { rrfFuse, type Ranked } from "../services/search/rrf"
import { VectorService } from "../services/vector"
import { evalCollection, loadJson } from "./fixtures"
import { indexCorpus, payloadString, qualitySummary } from "./helpers"
import { aggregate, scoreQuery } from "./metrics"
import type { EvalDocument, EvalQuery } from "./types"

/**
 * Sweeps RRF `k` and dense/sparse channel weights over the hybrid candidate
 * pool. Retrieves dense + sparse rankings once per query, then fuses in memory
 * for every (k, weight) pair — no re-indexing per config.
 *
 * Run: EVAL_FIXTURE_SET=fiqa-hn bun run eval:rrf
 */

const COLLECTION = evalCollection()
const SEARCH_LIMIT = 10
// Mirrors SearchService.candidateLimit(10) at the default RERANK_CANDIDATES=15.
const POOL = 15

const K_VALUES = [10, 30, 60, 100]

const WEIGHT_PAIRS = [
  { label: "d1:s1", dense: 1, sparse: 1 },
  { label: "d1:s0.5", dense: 1, sparse: 0.5 },
  { label: "d1:s0.25", dense: 1, sparse: 0.25 },
  { label: "d1:s0", dense: 1, sparse: 0 },
  { label: "d0.5:s1", dense: 0.5, sparse: 1 },
  { label: "d2:s1", dense: 2, sparse: 1 }
] as const

interface ChunkRef {
  chunkId: string
  documentId: string
}

const toRanked = (points: Awaited<ReturnType<VectorService["searchChunks"]>>): Array<Ranked<ChunkRef>> =>
  points.map(point => {
    const chunkId = payloadString(point.payload, "chunkId") || String(point.id)
    return { id: chunkId, item: { chunkId, documentId: payloadString(point.payload, "documentId") } }
  })

const run = async (): Promise<void> => {
  await verifyQdrantConnection()
  const corpus = await loadJson<EvalDocument[]>("corpus.json")
  const dataset = await loadJson<EvalQuery[]>("dataset.json")

  const qdrant = getQdrantClient()
  const vectors = new VectorService(qdrant, COLLECTION)

  console.log(`Indexing ${corpus.length} eval documents into ${COLLECTION}`)
  await indexCorpus(corpus, vectors, COLLECTION)

  const embeddings = getEmbeddingService()

  // Retrieve dense + sparse rankings once per query (fusion params don't affect them).
  console.log(`Retrieving dense + sparse rankings for ${dataset.length} queries (pool=${POOL})`)
  const perQuery: Array<{
    dense: Array<Ranked<ChunkRef>>
    sparse: Array<Ranked<ChunkRef>>
    relevant: string[]
  }> = []

  for (const item of dataset) {
    const queryVector = await embeddings.embed(item.query)
    const [densePoints, sparsePoints] = await Promise.all([
      vectors.searchChunks({ vector: queryVector, limit: POOL }),
      vectors.searchSparse({ sparse: toSparseVector(item.query), limit: POOL })
    ])
    perQuery.push({
      dense: toRanked(densePoints),
      sparse: toRanked(sparsePoints),
      relevant: item.relevantDocumentIds
    })
  }

  // Dense-only top-10 as the reference point (no fusion).
  const denseReference = qualitySummary(
    aggregate(
      perQuery.map(query =>
        scoreQuery(
          query.dense.slice(0, SEARCH_LIMIT).map(ranked => ranked.item.documentId),
          query.relevant
        )
      )
    )
  )

  const variants: Array<Record<string, unknown>> = []
  for (const pair of WEIGHT_PAIRS) {
    for (const k of K_VALUES) {
      const scores = perQuery.map(query =>
        scoreQuery(
          rrfFuse([query.dense, query.sparse], SEARCH_LIMIT, {
            k,
            weights: [pair.dense, pair.sparse]
          }).map(ref => ref.documentId),
          query.relevant
        )
      )
      const metrics = qualitySummary(aggregate(scores))
      variants.push({
        label: pair.label,
        k,
        denseWeight: pair.dense,
        sparseWeight: pair.sparse,
        ...metrics
      })
      console.log(`  ${pair.label} k=${k} → ${JSON.stringify(metrics)}`)
    }
  }

  const results = {
    collection: COLLECTION,
    model: getEmbeddingService().modelId,
    documents: corpus.length,
    queries: dataset.length,
    pool: POOL,
    searchLimit: SEARCH_LIMIT,
    denseReference,
    variants
  }

  const outPath = join(import.meta.dir, "../../eval-rrf-results.json")
  await mkdir(dirname(outPath), { recursive: true })
  await Bun.write(outPath, `${JSON.stringify(results, null, 2)}\n`)

  console.log("\nDense reference:", JSON.stringify(denseReference))
  console.log(`Wrote ${outPath}`)
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
