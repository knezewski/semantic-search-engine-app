import { env } from "../config/env"
import { getQdrantClient, verifyQdrantConnection } from "../db/qdrant.client"
import { splitDocument } from "../domain/chunk"
import { createDocumentRecord } from "../domain/document"
import { getEmbeddingService } from "../services/embedding"
import { SearchService } from "../services/search"
import { VectorService } from "../services/vector"
import { compareQueries, makeQueryResult, summarizeQueries } from "./report"
import { createEvalRun } from "./run-context"

const VARIANTS = [
  { chunkSize: 250, chunkOverlap: 25 },
  { chunkSize: 500, chunkOverlap: 50 },
  { chunkSize: 800, chunkOverlap: 80 }
] as const

const SEARCH_LIMIT = 10
const BASELINE = "500/50"
const DEPTH_POLICY = "deduplicate-within-returned-chunks-no-backfill"

type EvalRun = Awaited<ReturnType<typeof createEvalRun>>

const runVariant = async (run: EvalRun, chunkSize: number, chunkOverlap: number) => {
  const collection = run.collection(`chunks_${chunkSize}_${chunkOverlap}`)
  const qdrant = getQdrantClient()
  const vectors = new VectorService(qdrant, collection)
  const search = new SearchService(qdrant, collection)
  const embeddings = getEmbeddingService()

  const created = await vectors.ensureCollection(collection)
  if (!created.created) throw new Error(`Refusing to reuse evaluation collection ${collection}`)

  const indexStarted = performance.now()
  let chunkCount = 0
  for (const item of run.corpus) {
    const record = createDocumentRecord({ id: item.id, title: item.title, text: item.text, source: item.source })
    const chunks = await splitDocument(record, { chunkSize, chunkOverlap })
    chunkCount += chunks.length
    const chunkVectors = await embeddings.embedBatch(chunks.map(chunk => chunk.text))
    await vectors.upsertChunks(
      chunks.map((chunk, index) => ({ ...chunk, vector: chunkVectors[index] ?? [] })),
      collection
    )
  }
  const indexMs = performance.now() - indexStarted

  const queries = []
  for (const item of run.dataset) {
    const result = await search.searchTimed({ query: item.query, limit: SEARCH_LIMIT, mode: "dense" })
    queries.push(
      makeQueryResult(item, result.hits.slice(0, SEARCH_LIMIT), {
        degraded: result.degraded,
        timingMs: {
          embedMs: result.embedMs,
          qdrantMs: result.qdrantMs,
          rerankMs: result.rerankMs,
          totalMs: result.totalMs
        }
      })
    )
  }

  return {
    name: `${chunkSize}/${chunkOverlap}`,
    chunkSize,
    chunkOverlap,
    collection,
    collectionInfo: await qdrant.getCollection(collection),
    chunks: chunkCount,
    chunksPerDocument: chunkCount / run.corpus.length,
    indexMs,
    ...summarizeQueries(queries),
    queries
  }
}

const run = async (): Promise<void> => {
  const settings = {
    model: env.embeddingModel,
    requestedRevision: env.embeddingRevision ?? "main",
    dimensions: env.vectorSize,
    mode: "dense",
    searchLimit: SEARCH_LIMIT,
    depthPolicy: DEPTH_POLICY,
    searchHnswEf: env.searchHnswEf,
    baseline: BASELINE,
    grid: VARIANTS
  }
  const context = await createEvalRun("chunks", settings)
  await verifyQdrantConnection()
  await context.captureQdrant(getQdrantClient())

  const variants = []
  for (const variant of VARIANTS) {
    console.log(`Chunk experiment ${variant.chunkSize}/${variant.chunkOverlap}`)
    variants.push(await runVariant(context, variant.chunkSize, variant.chunkOverlap))
  }
  const baseline = variants.find(variant => variant.name === BASELINE)
  if (!baseline) throw new Error(`Missing chunk baseline ${BASELINE}`)

  const validForQualityComparison = variants.every(variant => variant.degradedQueries === 0)
  const results = {
    settings,
    validForQualityComparison,
    warning: validForQualityComparison
      ? null
      : "Fallbacks occurred. Inspect degraded queries and rerun before drawing quality conclusions.",
    documents: context.corpus.length,
    queries: context.dataset.length,
    variants: variants.map(variant => ({
      ...variant,
      comparisonToBaseline: compareQueries(baseline.queries, variant.queries, context.bootstrapOptions)
    }))
  }
  const outPath = await context.writeResults(results)
  console.log(
    JSON.stringify(
      variants.map(({ name, metrics, degradedQueries }) => ({ name, metrics, degradedQueries })),
      null,
      2
    )
  )
  console.log(`Wrote ${outPath}`)
  if (!validForQualityComparison) {
    throw new Error("Evaluation contains degraded searches; artifact saved but quality comparison is invalid")
  }
}

if (import.meta.main) {
  run().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
