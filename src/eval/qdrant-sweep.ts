import { join } from "node:path"
import { getQdrantClient, verifyQdrantConnection } from "../db/qdrant.client"
import { splitDocument } from "../domain/chunk"
import { createDocumentRecord } from "../domain/document"
import { getEmbeddingService, warmupEmbeddings } from "../services/embedding"
import { VectorService } from "../services/vector"
import { summarize } from "../utils/percentile"
import { aggregate, scoreQuery } from "./metrics"
import type { EvalDocument, EvalQuery } from "./types"

const INDEX_VARIANTS = [
  { name: "baseline", hnswM: 16, hnswEfConstruct: 128, scalarQuantization: false },
  { name: "int8", hnswM: 16, hnswEfConstruct: 128, scalarQuantization: true },
  { name: "hnsw-m32", hnswM: 32, hnswEfConstruct: 64, scalarQuantization: false }
] as const

const SEARCH_EF = [32, 64, 128]
const SEARCH_LIMIT = 10

const loadJson = async <T>(name: string): Promise<T> =>
  (await Bun.file(join(import.meta.dir, "fixtures", name)).json()) as T

const indexVariant = async (
  corpus: EvalDocument[],
  name: string,
  tune: { hnswM: number; hnswEfConstruct: number; scalarQuantization: boolean }
) => {
  const collection = `eval_hnsw_${name}`
  const qdrant = getQdrantClient()
  const existing = await qdrant.getCollections()
  if (existing.collections.some(item => item.name === collection)) {
    await qdrant.deleteCollection(collection)
  }

  const vectors = new VectorService(qdrant, collection)
  await vectors.ensureCollection(collection, tune)
  const embeddings = getEmbeddingService()

  for (const item of corpus) {
    const record = createDocumentRecord({
      id: item.id,
      title: item.title,
      text: item.text,
      source: item.source
    })
    const chunks = await splitDocument(record)
    const chunkVectors = await embeddings.embedBatch(chunks.map(chunk => chunk.text))
    await vectors.upsertChunks(
      chunks.map((chunk, index) => ({ ...chunk, vector: chunkVectors[index] ?? [] })),
      collection
    )
  }

  return vectors
}

const measure = async (vectors: VectorService, dataset: EvalQuery[], hnswEf: number) => {
  const embeddings = getEmbeddingService()
  const latencies: number[] = []
  const scores = []

  for (const item of dataset) {
    const queryVector = await embeddings.embed(item.query)
    const started = performance.now()
    const hits = await vectors.searchChunks({ vector: queryVector, limit: SEARCH_LIMIT, hnswEf })
    latencies.push(performance.now() - started)
    scores.push(
      scoreQuery(
        hits.map(hit => {
          const payload = (hit.payload ?? {}) as Record<string, unknown>
          return typeof payload.documentId === "string" ? payload.documentId : ""
        }),
        item.relevantDocumentIds
      )
    )
  }

  const summary = aggregate(scores)
  const timing = summarize(latencies)
  const round = (value: number) => Number(value.toFixed(4))
  return {
    hnswEf,
    metrics: {
      hitAt5: round(summary.hitAt5),
      mrr: round(summary.mrr),
      ndcgAt10: round(summary.ndcgAt10)
    },
    latencyMs: {
      p50: Number(timing.p50.toFixed(2)),
      p95: Number(timing.p95.toFixed(2))
    }
  }
}

const run = async (): Promise<void> => {
  await verifyQdrantConnection()
  await warmupEmbeddings()
  const corpus = await loadJson<EvalDocument[]>("corpus.json")
  const dataset = await loadJson<EvalQuery[]>("dataset.json")

  const variants = []
  for (const variant of INDEX_VARIANTS) {
    console.log(`Indexing Qdrant variant ${variant.name}`)
    const vectors = await indexVariant(corpus, variant.name, variant)
    const searches = []
    for (const hnswEf of SEARCH_EF) {
      searches.push(await measure(vectors, dataset, hnswEf))
    }
    variants.push({
      name: variant.name,
      hnswM: variant.hnswM,
      hnswEfConstruct: variant.hnswEfConstruct,
      scalarQuantization: variant.scalarQuantization,
      searches
    })
  }

  const results = { documents: corpus.length, queries: dataset.length, variants }
  const outPath = join(import.meta.dir, "../../eval-qdrant-results.json")
  await Bun.write(outPath, `${JSON.stringify(results, null, 2)}\n`)
  console.log(JSON.stringify(results, null, 2))
  console.log(`Wrote ${outPath}`)
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
