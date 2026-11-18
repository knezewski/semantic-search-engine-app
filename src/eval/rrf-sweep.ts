import { getQdrantClient, verifyQdrantConnection } from "../db/qdrant.client"
import { toSparseVector } from "../domain/sparse"
import { getEmbeddingService } from "../services/embedding"
import { type Ranked, rrfFuse } from "../services/search/rrf"
import { VectorService } from "../services/vector"
import { indexCorpus, payloadString } from "./helpers"
import { compareQueries, makeQueryResult, summarizeQueries } from "./report"
import { createEvalRun } from "./run-context"

const SEARCH_LIMIT = 10
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
  score: number
}
const toRanked = (points: Awaited<ReturnType<VectorService["searchChunks"]>>): Array<Ranked<ChunkRef>> =>
  points.map(point => {
    const chunkId = payloadString(point.payload, "chunkId") || String(point.id)
    return {
      id: chunkId,
      item: { chunkId, documentId: payloadString(point.payload, "documentId"), score: point.score }
    }
  })

const run = async (): Promise<void> => {
  const context = await createEvalRun("rrf", {
    searchLimit: SEARCH_LIMIT,
    pool: POOL,
    kValues: K_VALUES,
    weightPairs: WEIGHT_PAIRS
  })
  const collection = context.collection()
  await verifyQdrantConnection()
  const qdrant = getQdrantClient()
  await context.captureQdrant(qdrant)
  const vectors = new VectorService(qdrant, collection)
  await indexCorpus(context.corpus, vectors, collection)
  const embeddings = getEmbeddingService()

  const candidates = []
  for (const item of context.dataset) {
    const queryVector = await embeddings.embed(item.query)
    const [densePoints, sparsePoints] = await Promise.all([
      vectors.searchChunks({ vector: queryVector, limit: POOL }),
      vectors.searchSparse({ sparse: toSparseVector(item.query), limit: POOL })
    ])
    candidates.push({ item, dense: toRanked(densePoints), sparse: toRanked(sparsePoints) })
  }
  const baselineRows = candidates.map(({ item, dense }) =>
    makeQueryResult(
      item,
      dense.slice(0, SEARCH_LIMIT).map(hit => hit.item)
    )
  )
  const variants = []
  for (const pair of WEIGHT_PAIRS) {
    for (const k of K_VALUES) {
      const queryResults = candidates.map(({ item, dense, sparse }) => {
        const hits = rrfFuse([dense, sparse], SEARCH_LIMIT, { k, weights: [pair.dense, pair.sparse] })
        // rrfFuse returns items with their original dense/sparse score, not the fused score.
        // Omit it here rather than mislabeling it as a fusion score; source scores are saved below.
        return makeQueryResult(
          item,
          hits.map(({ documentId, chunkId }) => ({ documentId, chunkId }))
        )
      })
      const variant = {
        label: pair.label,
        k,
        denseWeight: pair.dense,
        sparseWeight: pair.sparse,
        ...summarizeQueries(queryResults),
        comparisonToDense: compareQueries(baselineRows, queryResults, context.bootstrapOptions),
        queryResults
      }
      variants.push(variant)
      console.log(`${pair.label} k=${k}: ${JSON.stringify(variant.metrics)}`)
    }
  }
  const path = await context.writeResults({
    collection,
    collectionInfo: await vectors.getCollection(collection),
    documents: context.corpus.length,
    queries: context.dataset.length,
    denseReference: { ...summarizeQueries(baselineRows), queryResults: baselineRows },
    candidates: candidates.map(({ item, dense, sparse }) => ({ id: item.id, dense, sparse })),
    variants
  })
  console.log(`Wrote ${path}`)
}

if (import.meta.main)
  run().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
