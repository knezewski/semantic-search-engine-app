import { env } from "../config/env"
import { getQdrantClient, verifyQdrantConnection } from "../db/qdrant.client"
import { splitDocument } from "../domain/chunk"
import { createDocumentRecord } from "../domain/document"
import { getEmbeddingService, warmupEmbeddings } from "../services/embedding"
import { VectorService } from "../services/vector"
import { summarize } from "../utils/percentile"
import { payloadString } from "./helpers"
import { compareQueries, makeQueryResult, summarizeQueries } from "./report"
import { createEvalRun } from "./run-context"

const INDEX_VARIANTS = [
  { name: "baseline", hnswM: 16, hnswEfConstruct: 128, scalarQuantization: false },
  { name: "int8", hnswM: 16, hnswEfConstruct: 128, scalarQuantization: true },
  { name: "hnsw-m32", hnswM: 32, hnswEfConstruct: 64, scalarQuantization: false }
] as const

const SEARCH_EF = [32, 64, 128]
const SEARCH_LIMIT = 10
const BASELINE = "baseline@ef64"
const DEPTH_POLICY = "deduplicate-within-returned-chunks-no-backfill"

type EvalRun = Awaited<ReturnType<typeof createEvalRun>>

const indexVariant = async (
  run: EvalRun,
  name: string,
  tune: { hnswM: number; hnswEfConstruct: number; scalarQuantization: boolean }
) => {
  const collection = run.collection(name)
  const qdrant = getQdrantClient()
  const vectors = new VectorService(qdrant, collection)
  const created = await vectors.ensureCollection(collection, tune)
  if (!created.created) throw new Error(`Refusing to reuse evaluation collection ${collection}`)
  const embeddings = getEmbeddingService()

  const indexStarted = performance.now()
  let chunkCount = 0
  for (const item of run.corpus) {
    const record = createDocumentRecord({ id: item.id, title: item.title, text: item.text, source: item.source })
    const chunks = await splitDocument(record, { chunkSize: env.chunkSize, chunkOverlap: env.chunkOverlap })
    chunkCount += chunks.length
    const chunkVectors = await embeddings.embedBatch(chunks.map(chunk => chunk.text))
    await vectors.upsertChunks(
      chunks.map((chunk, index) => ({ ...chunk, vector: chunkVectors[index] ?? [] })),
      collection
    )
  }

  return { vectors, collection, chunks: chunkCount, indexMs: performance.now() - indexStarted }
}

const measure = async (vectors: VectorService, run: EvalRun, hnswEf: number) => {
  const embeddings = getEmbeddingService()
  const latencies: number[] = []
  const queries = []

  for (const item of run.dataset) {
    const started = performance.now()
    const queryVector = await embeddings.embed(item.query)
    const embedMs = performance.now() - started
    const searchStarted = performance.now()
    const hits = await vectors.searchChunks({ vector: queryVector, limit: SEARCH_LIMIT, hnswEf })
    const qdrantMs = performance.now() - searchStarted
    latencies.push(qdrantMs)
    queries.push(
      makeQueryResult(
        item,
        hits.slice(0, SEARCH_LIMIT).map(hit => ({
          documentId: payloadString(hit.payload, "documentId"),
          chunkId: payloadString(hit.payload, "chunkId"),
          score: hit.score
        })),
        { timingMs: { embedMs, qdrantMs, totalMs: performance.now() - started } }
      )
    )
  }

  return {
    hnswEf,
    ...summarizeQueries(queries),
    queries,
    latencyMs: { scope: "qdrant-search-only", ...summarize(latencies) }
  }
}

const run = async (): Promise<void> => {
  const settings = {
    model: env.embeddingModel,
    requestedRevision: env.embeddingRevision ?? "main",
    dimensions: env.vectorSize,
    mode: "dense",
    chunkSize: env.chunkSize,
    chunkOverlap: env.chunkOverlap,
    searchLimit: SEARCH_LIMIT,
    depthPolicy: DEPTH_POLICY,
    baseline: BASELINE,
    grid: { indexes: INDEX_VARIANTS, searchEf: SEARCH_EF }
  }
  const context = await createEvalRun("qdrant", settings)
  await verifyQdrantConnection()
  await context.captureQdrant(getQdrantClient())
  await warmupEmbeddings()

  const variants = []
  for (const variant of INDEX_VARIANTS) {
    console.log(`Indexing Qdrant variant ${variant.name}`)
    const indexed = await indexVariant(context, variant.name, variant)
    const collectionInfoBeforeSearch = await indexed.vectors.getCollection(indexed.collection)
    const indexReadiness = {
      statusGreen: collectionInfoBeforeSearch.status === "green",
      optimizerHealthy: collectionInfoBeforeSearch.optimizer_status === "ok",
      indexedVectors: collectionInfoBeforeSearch.indexed_vectors_count ?? null,
      points: collectionInfoBeforeSearch.points_count ?? null,
      approximateIndexObserved: (collectionInfoBeforeSearch.indexed_vectors_count ?? 0) > 0,
      note: "Snapshot only, not an indexing barrier. Small collections may use unindexed scans; HNSW/quantization effects are not established without indexed vectors."
    }
    if (!indexReadiness.statusGreen || !indexReadiness.optimizerHealthy || !indexReadiness.approximateIndexObserved) {
      console.warn(`Variant ${variant.name}: index readiness is unconfirmed; inspect persisted collection metadata`)
    }
    const searches = []
    for (const hnswEf of SEARCH_EF) {
      searches.push({ name: `${variant.name}@ef${hnswEf}`, ...(await measure(indexed.vectors, context, hnswEf)) })
    }
    variants.push({
      ...variant,
      collection: indexed.collection,
      chunks: indexed.chunks,
      indexMs: indexed.indexMs,
      collectionInfoBeforeSearch,
      indexReadiness,
      collectionInfo: await indexed.vectors.getCollection(indexed.collection),
      searches
    })
  }
  const baseline = variants.flatMap(variant => variant.searches).find(search => search.name === BASELINE)
  if (!baseline) throw new Error(`Missing Qdrant baseline ${BASELINE}`)

  const results = {
    settings,
    documents: context.corpus.length,
    queries: context.dataset.length,
    variants: variants.map(variant => ({
      ...variant,
      searches: variant.searches.map(search => ({
        ...search,
        comparisonToBaseline: compareQueries(baseline.queries, search.queries, context.bootstrapOptions)
      }))
    }))
  }
  const outPath = await context.writeResults(results)
  console.log(
    JSON.stringify(
      variants.map(({ name, indexReadiness, searches }) => ({
        name,
        indexReadiness,
        searches: searches.map(({ hnswEf, metrics, latencyMs }) => ({ hnswEf, metrics, latencyMs }))
      })),
      null,
      2
    )
  )
  console.log(`Wrote ${outPath}`)
}

if (import.meta.main) {
  run().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
